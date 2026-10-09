import { randomUUID } from "node:crypto";
import { PLATFORMS, type Platform } from "../config/index.js";
import { getContent, transition } from "../db/content.js";
import { getCurrentWeights } from "../ideate/weights.js";
import { getItemsByIds } from "../ingest/store.js";
import type { Deps, JobData } from "../queue/types.js";
import { assertNotKilled, KillSwitchActive } from "../safety/killswitch.js";
import { assertCanPublish, PostCapReached } from "../safety/postingCaps.js";
import type { ScriptDoc } from "../script/types.js";
import { signedMediaUrl } from "./mediaHost.js";
import { buildPlatformMetadata, type PlatformMetadata } from "./metadata.js";
import { pickSlot } from "./schedule.js";
import { PublishError, type Publisher } from "./types.js";

export type PublishOutcome = "scheduled" | "published" | "rescheduled" | "skipped" | "failed";

const CHECKPOINT_DELAY_MS = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000 } as const;
const LATE_RESCHEDULE_MS = 6 * 3600_000;

export const fastMode = (deps: Deps): boolean => deps.cfg.env.DRY_RUN && deps.cfg.env.DRY_RUN_FAST;
export const fastStepMs = (deps: Deps): number => deps.cfg.env.DRY_RUN_FAST_STEP_S * 1000;
/** Real checkpoint delays, or compressed to seconds in dry-run fast mode (so demos/tests finish quickly). */
export const checkpointDelays = (deps: Deps): Record<"1h" | "24h" | "7d", number> =>
  fastMode(deps) ? { "1h": fastStepMs(deps), "24h": 2 * fastStepMs(deps), "7d": 3 * fastStepMs(deps) } : CHECKPOINT_DELAY_MS;
const enabled = (deps: Deps): Platform[] => PLATFORMS.filter((p) => deps.cfg.schedule.platforms[p].enabled);

export async function runPublish(deps: Deps, data: JobData): Promise<PublishOutcome> {
  return data.kind === "publish" ? publishOne(deps, data) : schedulePublications(deps, data);
}

// ------------------------------------------------------------------ schedule

async function takenTimes(deps: Deps, platform: Platform): Promise<Date[]> {
  const res = await deps.db.query<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM publications WHERE platform = $1 AND dry_run = $2 AND status IN ('scheduled','publishing','published') AND scheduled_at > $3`,
    [platform, deps.cfg.env.DRY_RUN, new Date(deps.now().getTime() - 24 * 3600_000).toISOString()],
  );
  return res.rows.map((r) => new Date(r.scheduled_at));
}

export async function schedulePublications(deps: Deps, data: JobData): Promise<PublishOutcome> {
  const { db, cfg, log } = deps;
  if (!data.contentId) throw new Error("publish/schedule job needs contentId");
  const content = await getContent(db, data.contentId);
  if (!content) throw new Error(`content ${data.contentId} not found`);
  if (content.status !== "qa_passed") {
    log.info({ contentId: content.id, status: content.status }, "schedule: not in qa_passed, skipping (idempotent)");
    return "skipped";
  }
  const script = content.script as unknown as ScriptDoc;
  const sources = await getItemsByIds(db, content.sourceItemIds);
  const weights = (await getCurrentWeights(db)).weights;
  const now = deps.now();

  let created = 0;
  for (const [idx, platform] of enabled(deps).entries()) {
    const taken = await takenTimes(deps, platform);
    const slot = fastMode(deps) ? new Date(now.getTime() + fastStepMs(deps) * (idx + 1)) : pickSlot({ cfg, platform, now, taken, hourWeights: weights.hours, rng: deps.rng });
    if (!slot) {
      log.warn({ contentId: content.id, platform }, "no free publishing slot within the horizon; skipping platform");
      continue;
    }
    const meta = buildPlatformMetadata(platform, content, script, sources);
    const id = randomUUID();
    const ins = await db.query(
      `INSERT INTO publications (id, content_id, platform, status, scheduled_at, metadata, dry_run) VALUES ($1,$2,$3,'scheduled',$4,$5::jsonb,$6) ON CONFLICT (content_id, platform) DO NOTHING`,
      [id, content.id, platform, slot.toISOString(), JSON.stringify({ meta, reschedules: 0 }), cfg.env.DRY_RUN],
    );
    if (ins.rowCount === 0) continue; // already scheduled by an earlier delivery
    created++;
    await deps.enqueue("publish", { kind: "publish", contentId: content.id, publicationId: id, correlationId: content.correlationId, regen: 0 }, { delayMs: Math.max(0, slot.getTime() - now.getTime()) });
    log.info({ contentId: content.id, correlationId: content.correlationId, platform, scheduledAt: slot.toISOString() }, "publication scheduled");
  }
  if (created === 0) throw new Error("no publication slots could be created (all platforms full?)");
  await transition(db, content.id, "qa_passed", "scheduled", {}, { stage: "publish", detail: { publications: created } });
  return "scheduled";
}

// ------------------------------------------------------------------ publish one

interface PubRow {
  id: string;
  content_id: string;
  platform: Platform;
  status: string;
  scheduled_at: string;
  metadata: { meta: PlatformMetadata; reschedules?: number; warnings?: string[] };
  attempts: number;
}

async function reschedule(deps: Deps, pub: PubRow, reason: string): Promise<void> {
  const { db, cfg, log } = deps;
  const now = deps.now();
  const taken = (await takenTimes(deps, pub.platform)).filter((t) => t.getTime() !== new Date(pub.scheduled_at).getTime());
  const weights = (await getCurrentWeights(db)).weights;
  const slot = fastMode(deps) ? new Date(now.getTime() + 2 * fastStepMs(deps)) : (pickSlot({ cfg, platform: pub.platform, now, taken, hourWeights: weights.hours, rng: deps.rng }) ?? new Date(now.getTime() + 3600_000));
  const n = (pub.metadata.reschedules ?? 0) + 1;
  await db.query(`UPDATE publications SET scheduled_at = $2, status = 'scheduled', metadata = jsonb_set(metadata, '{reschedules}', $3::jsonb), updated_at = now() WHERE id = $1`, [pub.id, slot.toISOString(), JSON.stringify(n)]);
  const content = await getContent(db, pub.content_id);
  await deps.enqueue("publish", { kind: "publish", contentId: pub.content_id, publicationId: pub.id, correlationId: content?.correlationId ?? randomUUID(), regen: n }, { delayMs: Math.max(0, slot.getTime() - now.getTime()) });
  log.warn({ publicationId: pub.id, platform: pub.platform, reason, newSlot: slot.toISOString() }, "publication rescheduled");
}

export async function publishOne(deps: Deps, data: JobData): Promise<PublishOutcome> {
  const { db, cfg, log } = deps;
  if (!data.publicationId) throw new Error("publish job needs publicationId");
  const res = await db.query<PubRow>(`SELECT * FROM publications WHERE id = $1`, [data.publicationId]);
  const pub = res.rows[0];
  if (!pub || pub.status !== "scheduled") {
    log.info({ publicationId: data.publicationId, status: pub?.status }, "publish: not in scheduled state, skipping (idempotent)");
    return "skipped";
  }
  const content = await getContent(db, pub.content_id);
  if (!content || !["scheduled", "published"].includes(content.status)) {
    log.warn({ publicationId: pub.id, contentStatus: content?.status }, "publish: content not publishable, skipping");
    return "skipped";
  }

  // 1. kill switch — throws KillSwitchActive; the worker wrapper delays the job without consuming a retry
  await assertNotKilled(db, cfg.env);

  // 2. caps — over a cap means "not now", so move to a later slot instead of failing
  try {
    await assertCanPublish(db, cfg, pub.platform, deps.now());
  } catch (e) {
    if (e instanceof PostCapReached) {
      await reschedule(deps, pub, e.message);
      return "rescheduled";
    }
    throw e;
  }
  if (!fastMode(deps) && deps.now().getTime() - new Date(pub.scheduled_at).getTime() > LATE_RESCHEDULE_MS) {
    await reschedule(deps, pub, "missed its window (e.g. kill switch was on); moving to the next slot");
    return "rescheduled";
  }

  // 3. claim. Only one worker can win this UPDATE, which is what prevents a double post.
  const claim = await db.query(`UPDATE publications SET status = 'publishing', attempts = attempts + 1, updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [pub.id]);
  if (claim.rowCount === 0) return "skipped";

  const publisher = deps.publishers?.[pub.platform];
  if (!publisher) {
    await db.query(`UPDATE publications SET status = 'scheduled', error = 'no publisher configured', updated_at = now() WHERE id = $1`, [pub.id]);
    throw new Error(`no publisher configured for ${pub.platform}`);
  }

  const render = content.render as any;
  const meta = pub.metadata.meta;
  try {
    const result = await publisher.publish({
      contentId: content.id,
      videoPath: render.videoPath,
      coverPath: render.coverPath,
      mediaUrl: signedMediaUrl(cfg, content.id, content.regenCount, "video", 6 * 3600_000, deps.now().getTime()),
      coverUrl: signedMediaUrl(cfg, content.id, content.regenCount, "cover", 6 * 3600_000, deps.now().getTime()),
      durationS: render.durationS,
      meta,
      // final gate right before the irreversible call: kill switch + caps again (excluding ourselves)
      assertLive: async () => {
        await assertNotKilled(db, cfg.env);
        await assertCanPublish(db, cfg, pub.platform, deps.now(), pub.id);
      },
    });
    await db.query(
      `UPDATE publications SET status = 'published', external_id = $2, url = $3, published_at = $4, error = NULL, metadata = metadata || $5::jsonb, updated_at = now() WHERE id = $1`,
      [pub.id, result.externalId, result.url ?? null, deps.now().toISOString(), JSON.stringify({ warnings: result.warnings ?? [] })],
    );
    await transition(db, content.id, "scheduled", "published", {}, { stage: "publish", detail: { platform: pub.platform, externalId: result.externalId } });
    log.info({ contentId: content.id, correlationId: content.correlationId, platform: pub.platform, externalId: result.externalId, url: result.url, live: publisher.live }, "published");
    for (const w of result.warnings ?? []) if (publisher.live) await deps.alerter.send({ key: `publish_warning:${pub.platform}`, severity: "warning", title: `${pub.platform} publish warning`, body: w, throttleMs: 6 * 3600_000 });

    const delays = checkpointDelays(deps);
    for (const cp of cfg.schedule.analytics.checkpoints) {
      await deps.enqueue("analytics", { publicationId: pub.id, contentId: content.id, correlationId: content.correlationId, checkpoint: cp }, { delayMs: delays[cp] });
    }
    return "published";
  } catch (e) {
    return handlePublishFailure(deps, pub, content.topic, e);
  }
}

async function handlePublishFailure(deps: Deps, pub: PubRow, topic: string, e: unknown): Promise<PublishOutcome> {
  const { db, log } = deps;
  const msg = (e as Error).message.slice(0, 500);
  const restore = async (error: string) => db.query(`UPDATE publications SET status = 'scheduled', error = $2, updated_at = now() WHERE id = $1`, [pub.id, error]);

  if (e instanceof KillSwitchActive) {
    await restore("kill switch active; held until released");
    throw e; // worker wrapper delays the job and does not burn a retry
  }
  if (e instanceof PostCapReached) {
    await reschedule(deps, pub, e.message);
    return "rescheduled";
  }
  if (e instanceof PublishError && !e.retryable) {
    await db.query(`UPDATE publications SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [pub.id, msg]);
    await deps.alerter.send({
      key: `publish_failed:${pub.id}`,
      severity: "critical",
      title: e.ambiguous ? `${pub.platform} publish OUTCOME UNKNOWN — check the account by hand (not retried, to avoid a double post)` : `${pub.platform} publish failed (not retryable)`,
      body: `${topic}\n${msg}`,
      throttleMs: 0,
    });
    log.error({ publicationId: pub.id, platform: pub.platform, ambiguous: e.ambiguous, err: msg }, "publish failed permanently");
    await failContentIfAllFailed(deps, pub.content_id);
    return "failed";
  }
  // retryable (transient platform error, missing/expired token, network) — let BullMQ back off and retry
  await restore(msg);
  await deps.alerter.send({ key: `publish_retry:${pub.platform}`, severity: "warning", title: `${pub.platform} publish failed, will retry`, body: msg, throttleMs: 30 * 60_000 });
  throw e;
}

async function failContentIfAllFailed(deps: Deps, contentId: string): Promise<void> {
  const r = await deps.db.query<{ status: string }>(`SELECT status FROM publications WHERE content_id = $1`, [contentId]);
  if (r.rows.length > 0 && r.rows.every((x) => x.status === "failed")) {
    await transition(deps.db, contentId, "scheduled", "failed", { error: "every platform publish failed", failed_stage: "publish" }, { stage: "publish" });
  }
}

export type { Publisher };
