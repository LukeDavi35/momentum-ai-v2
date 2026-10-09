import { transition } from "../db/content.js";
import type { Deps, JobData } from "../queue/types.js";

export type AnalyticsOutcome = "recorded" | "skipped";

/**
 * Pulls platform metrics for one publication at one checkpoint (1h / 24h / 7d) and stores a snapshot.
 * Metrics a platform doesn't expose stay NULL — absent data is never turned into zeros.
 */
export async function runAnalytics(deps: Deps, data: JobData): Promise<AnalyticsOutcome> {
  const { db, cfg, log } = deps;
  if (!data.publicationId || !data.checkpoint) throw new Error("analytics job needs publicationId + checkpoint");
  const res = await db.query(`SELECT * FROM publications WHERE id = $1`, [data.publicationId]);
  const pub = res.rows[0];
  if (!pub || pub.status !== "published" || !pub.external_id) {
    log.info({ publicationId: data.publicationId, status: pub?.status }, "analytics: publication not published, skipping");
    return "skipped";
  }
  const publisher = deps.publishers?.[pub.platform as "tiktok" | "instagram" | "youtube"];
  if (!publisher) throw new Error(`no publisher configured for ${pub.platform}`);

  const m = await publisher.metrics(pub.external_id, { caption: pub.metadata?.meta?.caption, publishedAt: pub.published_at ? new Date(pub.published_at) : undefined, checkpoint: data.checkpoint });
  if (m.views === undefined) throw new Error(`${pub.platform} metrics not available yet for ${pub.external_id}`); // BullMQ retries with backoff

  await db.query(
    `INSERT INTO analytics_snapshots (publication_id, checkpoint, taken_at, views, likes, comments, shares, saves, follows, watch_time_s, avg_view_duration_s, retention_pct, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (publication_id, checkpoint) DO UPDATE SET taken_at = EXCLUDED.taken_at, views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments, shares = EXCLUDED.shares,
       saves = EXCLUDED.saves, follows = EXCLUDED.follows, watch_time_s = EXCLUDED.watch_time_s, avg_view_duration_s = EXCLUDED.avg_view_duration_s, retention_pct = EXCLUDED.retention_pct, raw = EXCLUDED.raw`,
    [pub.id, data.checkpoint, deps.now().toISOString(), m.views ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null, m.saves ?? null, m.follows ?? null, m.watchTimeS ?? null, m.avgViewDurationS ?? null, m.retentionPct ?? null, JSON.stringify(m.raw ?? {})],
  );
  log.info({ publicationId: pub.id, platform: pub.platform, checkpoint: data.checkpoint, views: m.views }, "analytics snapshot recorded");

  // the content is "measured" once every published publication has its final checkpoint
  const last = cfg.schedule.analytics.checkpoints.at(-1)!;
  if (data.checkpoint === last && data.contentId) {
    const open = await db.query(
      `SELECT 1 FROM publications p WHERE p.content_id = $1 AND p.status = 'published' AND NOT EXISTS (SELECT 1 FROM analytics_snapshots s WHERE s.publication_id = p.id AND s.checkpoint = $2) LIMIT 1`,
      [data.contentId, last],
    );
    if (open.rowCount === 0) await transition(db, data.contentId, "published", "measured", {}, { stage: "analytics" });
  }
  return "recorded";
}
