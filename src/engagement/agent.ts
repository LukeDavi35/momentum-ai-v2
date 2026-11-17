import { randomUUID } from "node:crypto";
import type { Platform } from "../config/index.js";
import type { Deps } from "../queue/types.js";
import { checkReply, isCrisisLanguage, isEmojiOnly, isLikelySpam } from "./policy.js";
import { COMMENT_PLATFORMS } from "./sources/index.js";
import { decide, triageComment, type Category } from "./triage.js";
import type { CommentSource } from "./types.js";

const FETCH_BATCH_PUBLICATIONS = 20;
const TRIAGE_BATCH = 5;

export interface CommentPollResult {
  fetched: number;
  triaged: number;
  sent: "reply" | "hide" | "none";
}

const duePlatforms = (deps: Deps): Platform[] => COMMENT_PLATFORMS.filter((p) => deps.cfg.schedule.platforms[p]?.replies && deps.commentSources?.[p]);

async function fetchNewComments(deps: Deps, platforms: Platform[]): Promise<number> {
  const { db, cfg, now } = deps;
  const since = new Date(now().getTime() - cfg.schedule.comments.lookbackDays * 86_400_000);
  let inserted = 0;
  for (const platform of platforms) {
    const source = deps.commentSources![platform] as CommentSource;
    const pubs = await db.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM publications WHERE platform = $1 AND status = 'published' AND published_at >= $2 ORDER BY published_at DESC LIMIT $3`,
      [platform, since.toISOString(), FETCH_BATCH_PUBLICATIONS],
    );
    for (const pub of pubs.rows) {
      if (!pub.external_id) continue;
      let comments;
      try {
        comments = await source.fetchComments(pub.external_id);
      } catch (e) {
        deps.log.warn({ platform, publicationId: pub.id, err: (e as Error).message }, "comment fetch failed");
        continue;
      }
      for (const c of comments) {
        const res = await db.query(
          `INSERT INTO comments (id, publication_id, platform, external_id, author, author_id, text, posted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (platform, external_id) DO NOTHING`,
          [randomUUID(), pub.id, platform, c.externalId, c.author, c.authorId, c.text, c.postedAt?.toISOString() ?? null],
        );
        if (res.rowCount) inserted++;
      }
    }
  }
  return inserted;
}

interface PendingRow {
  id: string;
  publication_id: string;
  platform: Platform;
  external_id: string;
  text: string;
  posted_at: string | null;
}

function eligibleAt(deps: Deps, postedAt: Date): Date {
  const { delayMinutesMin, delayMinutesMax } = deps.cfg.schedule.comments;
  const rng = deps.rng ?? Math.random;
  const minutes = delayMinutesMin + rng() * Math.max(0, delayMinutesMax - delayMinutesMin);
  return new Date(postedAt.getTime() + minutes * 60_000);
}

async function triagePending(deps: Deps, platforms: Platform[]): Promise<number> {
  const { db, now } = deps;
  const rows = await db.query<PendingRow>(
    `SELECT c.id, c.publication_id, c.platform, c.external_id, c.text, c.posted_at FROM comments c
     WHERE c.status = 'new' AND c.platform = ANY($1) ORDER BY c.created_at ASC LIMIT $2`,
    [platforms, TRIAGE_BATCH],
  );
  let triaged = 0;
  for (const row of rows.rows) {
    const posted = row.posted_at ? new Date(row.posted_at) : now();
    if (isCrisisLanguage(row.text)) {
      await db.query(`UPDATE comments SET status = 'held', error = 'crisis language detected - needs a human, not a bot', updated_at = now() WHERE id = $1`, [row.id]);
      await deps.alerter.send({ key: `comment_crisis:${row.id}`, severity: "critical", title: "A comment needs a human right now (crisis language)", body: `${row.platform} comment on publication ${row.publication_id}: "${row.text.slice(0, 300)}"`, throttleMs: 0 });
      triaged++;
      continue;
    }
    if (isEmojiOnly(row.text)) {
      await db.query(`UPDATE comments SET status = 'skipped', category = 'emoji_only', updated_at = now() WHERE id = $1`, [row.id]);
      triaged++;
      continue;
    }
    if (isLikelySpam(row.text)) {
      await db.query(`UPDATE comments SET status = 'queued', category = 'spam', eligible_at = $2, updated_at = now() WHERE id = $1`, [row.id, now().toISOString()]);
      triaged++;
      continue;
    }
    const content = await db.query<{ topic: string }>(
      `SELECT content.topic FROM publications JOIN content ON content.id = publications.content_id WHERE publications.id = $1`,
      [row.publication_id],
    );
    const topic = content.rows[0]?.topic ?? "a sports story";
    let result;
    try {
      result = await triageComment(deps.llm, row.text, topic);
    } catch (e) {
      deps.log.warn({ commentId: row.id, err: (e as Error).message }, "comment triage LLM call failed; leaving it for the next poll");
      continue;
    }
    const category = result.category as Category;
    const action = decide(category);
    const eligible = eligibleAt(deps, posted);
    if (action === "reply") {
      const check = checkReply(result.reply, category === "ai_question");
      if (check.ok) {
        await db.query(`UPDATE comments SET status = 'queued', category = $2, reply_text = $3, eligible_at = $4, updated_at = now() WHERE id = $1`, [row.id, category, result.reply, eligible.toISOString()]);
      } else {
        await db.query(`UPDATE comments SET status = 'held', category = $2, reply_text = $3, error = $4, updated_at = now() WHERE id = $1`, [row.id, category, result.reply, check.issues.join("; ")]);
      }
    } else if (action === "hide") {
      await db.query(`UPDATE comments SET status = 'queued', category = $2, eligible_at = $3, updated_at = now() WHERE id = $1`, [row.id, category, now().toISOString()]);
    } else if (action === "hold") {
      await db.query(`UPDATE comments SET status = 'held', category = $2, reply_text = $3, updated_at = now() WHERE id = $1`, [row.id, category, result.reply || null]);
    } else {
      await db.query(`UPDATE comments SET status = 'skipped', category = $2, updated_at = now() WHERE id = $1`, [row.id, category]);
    }
    triaged++;
  }
  return triaged;
}

interface QueuedRow extends PendingRow {
  category: Category;
  reply_text: string | null;
  author_id: string;
}

/** At most one reply or hide per tick, re-checking every cap right before sending (rows can go stale between triage and send). */
async function sendOneDue(deps: Deps, platforms: Platform[]): Promise<"reply" | "hide" | "none"> {
  const { db, cfg, now } = deps;
  const c = cfg.schedule.comments;
  const dueNow = now();

  const lastSent = await db.query<{ at: string | null }>(`SELECT MAX(acted_at) AS at FROM comments WHERE status IN ('replied', 'hidden')`);
  const last = lastSent.rows[0]?.at ? new Date(lastSent.rows[0].at!) : null;
  if (last && dueNow.getTime() - last.getTime() < c.minGapSeconds * 1000) return "none";

  const dailyCount = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM comments WHERE status IN ('replied', 'hidden') AND acted_at >= $1`, [new Date(dueNow.getTime() - 86_400_000).toISOString()]);
  if (Number(dailyCount.rows[0]?.n ?? 0) >= c.dailyCap) return "none";

  const candidates = await db.query<QueuedRow>(
    `SELECT id, publication_id, platform, external_id, text, posted_at, category, reply_text, author_id FROM comments
     WHERE status = 'queued' AND platform = ANY($1) AND eligible_at <= $2 ORDER BY eligible_at ASC LIMIT 10`,
    [platforms, dueNow.toISOString()],
  );

  for (const row of candidates.rows) {
    const postedAt = row.posted_at ? new Date(row.posted_at) : dueNow;
    if (dueNow.getTime() - postedAt.getTime() > c.windowHours * 3600_000) {
      await db.query(`UPDATE comments SET status = 'skipped', error = 'too old by the time it was eligible to send', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    const perPost = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM comments WHERE publication_id = $1 AND status IN ('replied', 'hidden')`, [row.publication_id]);
    if (Number(perPost.rows[0]?.n ?? 0) >= c.perPostCap) {
      await db.query(`UPDATE comments SET status = 'skipped', error = 'per-post reply cap reached', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    if (row.author_id) {
      const perAuthor = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM comments WHERE platform = $1 AND author_id = $2 AND status IN ('replied', 'hidden') AND acted_at >= $3`,
        [row.platform, row.author_id, new Date(dueNow.getTime() - 86_400_000).toISOString()],
      );
      if (Number(perAuthor.rows[0]?.n ?? 0) >= c.perAuthorDaily) {
        await db.query(`UPDATE comments SET status = 'skipped', error = 'per-author daily cap reached', updated_at = now() WHERE id = $1`, [row.id]);
        continue;
      }
    }

    const action = decide(row.category);
    const source = deps.commentSources![row.platform];
    if (!source) continue;
    try {
      if (action === "hide") {
        await source.hide(row.external_id);
        await db.query(`UPDATE comments SET status = 'hidden', acted_at = $2, updated_at = now() WHERE id = $1`, [row.id, dueNow.toISOString()]);
        return "hide";
      }
      if (action === "reply" && row.reply_text) {
        await source.reply(row.external_id, row.reply_text);
        await db.query(`UPDATE comments SET status = 'replied', acted_at = $2, updated_at = now() WHERE id = $1`, [row.id, dueNow.toISOString()]);
        return "reply";
      }
      // category resolved to "hold"/"skip" after the row was queued (shouldn't happen) - leave it for a human to notice via status='queued'
    } catch (e) {
      deps.log.warn({ commentId: row.id, platform: row.platform, err: (e as Error).message }, "comment reply/hide failed; will retry next tick");
      await deps.alerter.send({ key: `comment_action_failed:${row.platform}`, severity: "warning", title: `${row.platform} comment reply/hide failed, will retry`, body: (e as Error).message, throttleMs: 30 * 60_000 });
    }
  }
  return "none";
}

export async function runCommentPoll(deps: Deps): Promise<CommentPollResult> {
  const platforms = duePlatforms(deps);
  if (platforms.length === 0) return { fetched: 0, triaged: 0, sent: "none" };
  const fetched = await fetchNewComments(deps, platforms);
  const triaged = await triagePending(deps, platforms);
  const sent = await sendOneDue(deps, platforms);
  return { fetched, triaged, sent };
}
