import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runWeeklyLearning } from "../learning/agent.js";
import { findStuck, type ContentStatus } from "../db/content.js";
import { getSetting, setSetting } from "../db/settings.js";
import { checkpointDelays } from "../publish/agent.js";
import type { TokenStore } from "../publish/tokens.js";
import { PLATFORMS, type SpendProvider } from "../config/index.js";
import { QUEUE_NAMES, type QueueName } from "./names.js";
import type { QueueSet } from "./queues.js";
import { jobIdFor, type Deps, type JobData } from "./types.js";
import { PAUSED_KEY, type PausedQueues } from "./worker.js";

/** true if a not-yet-finished job (waiting / active / delayed) with this id exists. */
export type HasPending = (queue: QueueName, jobId: string) => Promise<boolean>;

const STUCK_MS = 20 * 60_000;
const NEXT_STAGE: Partial<Record<ContentStatus, QueueName>> = { idea: "script", scripted: "voice", voiced: "render", rendered: "qa", qa_passed: "publish" };

export interface ReconcileResult {
  contentRequeued: number;
  publicationsRequeued: number;
  analyticsRequeued: number;
  publishingParked: number;
}

/**
 * Self-healing. Every stage commits its DB transition and THEN enqueues the next job, so a crash
 * between the two would strand an item. This finds items that have sat in an in-flight state too
 * long with no live job and enqueues the missing one (fresh id, so a retained completed job
 * with the old id can't swallow it). Also parks publish attempts whose worker died mid-flight.
 */
export async function reconcile(deps: Deps, hasPending: HasPending): Promise<ReconcileResult> {
  const { db, cfg, log } = deps;
  const now = deps.now();
  const bucket = Math.floor(now.getTime() / STUCK_MS);
  const out: ReconcileResult = { contentRequeued: 0, publicationsRequeued: 0, analyticsRequeued: 0, publishingParked: 0 };

  for (const c of await findStuck(db, Object.keys(NEXT_STAGE) as ContentStatus[], STUCK_MS, now)) {
    const queue = NEXT_STAGE[c.status]!;
    const data: JobData = { contentId: c.id, correlationId: c.correlationId, regen: c.regenCount, ...(c.status === "qa_passed" ? { kind: "schedule" } : {}) };
    const id = jobIdFor(queue, data);
    if (await hasPending(queue, id)) continue;
    await deps.enqueue(queue, data, { jobId: `${id}__rc${bucket}` });
    out.contentRequeued++;
    log.warn({ contentId: c.id, correlationId: c.correlationId, status: c.status, queue }, "reconcile: stuck item re-enqueued");
  }

  // scheduled publications that are overdue with no job behind them
  const due = await db.query(`SELECT id, content_id, scheduled_at, metadata FROM publications WHERE status = 'scheduled' AND scheduled_at < $1`, [new Date(now.getTime() - 15 * 60_000).toISOString()]);
  for (const p of due.rows) {
    const data: JobData = { kind: "publish", contentId: p.content_id, publicationId: p.id, correlationId: p.content_id, regen: p.metadata?.reschedules ?? 0 };
    const id = jobIdFor("publish", data);
    if (await hasPending("publish", id)) continue;
    const c = await db.query<{ correlation_id: string }>(`SELECT correlation_id FROM content WHERE id = $1`, [p.content_id]);
    await deps.enqueue("publish", { ...data, correlationId: c.rows[0]?.correlation_id ?? p.content_id }, { jobId: `${id}__rc${bucket}` });
    out.publicationsRequeued++;
  }

  // a publication stuck in `publishing` means a worker died mid-publish: the outcome is UNKNOWN, so never auto-retry
  const stuckPub = await db.query(`SELECT id, platform, content_id FROM publications WHERE status = 'publishing' AND updated_at < $1`, [new Date(now.getTime() - 30 * 60_000).toISOString()]);
  for (const p of stuckPub.rows) {
    await db.query(`UPDATE publications SET status = 'failed', error = 'worker died mid-publish; outcome unknown - verify on the platform before retrying', updated_at = now() WHERE id = $1 AND status = 'publishing'`, [p.id]);
    await deps.alerter.send({ key: `publish_stuck:${p.id}`, severity: "critical", title: `${p.platform} publish interrupted — OUTCOME UNKNOWN`, body: `Check the ${p.platform} account for content ${p.content_id} before re-posting by hand.`, throttleMs: 0 });
    out.publishingParked++;
  }

  // published posts whose analytics checkpoint is due but missing
  const delays = checkpointDelays(deps);
  const pubs = await db.query(`SELECT p.id, p.content_id, p.published_at, c.correlation_id FROM publications p JOIN content c ON c.id = p.content_id WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at > $1`, [new Date(now.getTime() - 9 * 86400_000).toISOString()]);
  for (const p of pubs.rows) {
    for (const cp of cfg.schedule.analytics.checkpoints) {
      if (new Date(p.published_at).getTime() + delays[cp] + 15 * 60_000 > now.getTime()) continue; // not overdue yet
      const have = await db.query(`SELECT 1 FROM analytics_snapshots WHERE publication_id = $1 AND checkpoint = $2`, [p.id, cp]);
      if (have.rowCount > 0) continue;
      const data: JobData = { publicationId: p.id, contentId: p.content_id, correlationId: p.correlation_id, checkpoint: cp };
      const id = jobIdFor("analytics", data);
      if (await hasPending("analytics", id)) continue;
      await deps.enqueue("analytics", data, { jobId: `${id}__rc${bucket}` });
      out.analyticsRequeued++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ monitor

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}
export type GetCounts = (queue: QueueName) => Promise<QueueCounts>;

export interface MonitorResult {
  backlogAlerts: string[];
  resumed: string[];
}

export async function monitor(deps: Deps, getCounts: GetCounts, resume: (queue: QueueName) => Promise<void>): Promise<MonitorResult> {
  const { cfg, db, log } = deps;
  const out: MonitorResult = { backlogAlerts: [], resumed: [] };

  for (const q of QUEUE_NAMES) {
    const c = await getCounts(q);
    if (c.waiting > cfg.limits.queueBacklogAlert) {
      out.backlogAlerts.push(q);
      await deps.alerter.send({ key: `backlog:${q}`, severity: "warning", title: `Queue backlog: "${q}" has ${c.waiting} waiting jobs (threshold ${cfg.limits.queueBacklogAlert})`, body: `active=${c.active} delayed=${c.delayed} failed=${c.failed}`, throttleMs: 60 * 60_000 });
    }
  }

  // resume queues that were paused for a spend cap once the provider is back under its cap
  const paused = (await getSetting<PausedQueues>(db, PAUSED_KEY)) ?? {};
  for (const [q, info] of Object.entries(paused)) {
    if (!(await deps.spend.isCapped(info.provider as SpendProvider))) {
      await resume(q as QueueName);
      delete paused[q];
      out.resumed.push(q);
      log.info({ queue: q, provider: info.provider }, "spend cap cleared; queue resumed");
    }
  }
  if (out.resumed.length > 0) {
    await setSetting(db, PAUSED_KEY, paused, "monitor");
    await deps.alerter.send({ key: "spend_resume", severity: "info", title: `Queues resumed after spend cap cleared: ${out.resumed.join(", ")}`, throttleMs: 0 });
  }
  return out;
}

// ------------------------------------------------------------------ housekeeping

/** Deletes rendered media for pieces that are finished (measured/failed) and older than `days`. Held items are kept for review. */
export async function housekeeping(deps: Deps, days = 14): Promise<{ removed: number }> {
  const { db, cfg } = deps;
  const cutoff = new Date(deps.now().getTime() - days * 86400_000).toISOString();
  const res = await db.query<{ id: string }>(`SELECT id FROM content WHERE status IN ('measured','failed') AND status_changed_at < $1`, [cutoff]);
  let removed = 0;
  for (const r of res.rows) {
    const dir = join(cfg.env.MEDIA_DIR, r.id);
    try {
      statSync(dir);
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* already gone */
    }
  }
  void readdirSync;
  return { removed };
}

// ------------------------------------------------------------------ dispatcher

export function makeMaintenanceHandler(qs: QueueSet, tokens: TokenStore | undefined) {
  const hasPending: HasPending = async (queue, jobId) => {
    const job = await qs.queues[queue].getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return ["waiting", "active", "delayed", "prioritized", "waiting-children"].includes(state);
  };
  return async (deps: Deps, data: JobData): Promise<unknown> => {
    switch (data.kind) {
      case "reconcile":
        return reconcile(deps, hasPending);
      case "monitor":
        return monitor(
          deps,
          async (q) => {
            const c = await qs.queues[q].getJobCounts("waiting", "active", "delayed", "failed");
            return { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
          },
          async (q) => qs.queues[q].resume(),
        );
      case "refresh-tokens":
        if (deps.cfg.env.DRY_RUN || !tokens) return "skipped (dry run or no token store)";
        return tokens.refreshExpiring(PLATFORMS.filter((p) => deps.cfg.schedule.platforms[p].enabled));
      case "weekly-learning":
        return runWeeklyLearning(deps);
      case "housekeeping":
        return housekeeping(deps);
      default:
        throw new Error(`unknown maintenance job kind: ${data.kind}`);
    }
  };
}
