import type { Platform, Pillar, Template } from "../config/index.js";
import type { Db } from "../db/db.js";
import { lengthBucket, type LengthBucket } from "../ideate/weights.js";
import { localParts } from "../publish/schedule.js";

export interface PerfRow {
  publicationId: string;
  contentId: string;
  platform: Platform;
  template: Template;
  pillar: Pillar;
  topic: string;
  hookStyle: string | null;
  lengthS: number;
  lengthBucket: LengthBucket;
  hour: string; // local posting hour "00".."23"
  checkpoint: "1h" | "24h" | "7d";
  views: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
  retentionPct: number | null;
  avgViewDurationS: number | null;
  ideaScores: { velocity?: number; templateFit?: number; novelty?: number; engagement?: number } | null;
  dryRun: boolean;
  synthetic: boolean;
  publishedAt: Date;
  score?: number;
}

const CP_RANK: Record<string, number> = { "7d": 3, "24h": 2, "1h": 1 };

/** One row per publication, using its most mature snapshot (7d > 24h > 1h). */
export async function loadPerfRows(db: Db, opts: { since: Date; includeDryRun: boolean; tz: string }): Promise<PerfRow[]> {
  const res = await db.query(
    `SELECT p.id AS pub_id, p.content_id, p.platform, p.published_at, p.dry_run,
            c.template, c.pillar, c.topic, c.hook_style, c.idea, c.script, c.render,
            s.checkpoint, s.views, s.likes, s.comments, s.shares, s.saves, s.follows, s.retention_pct, s.avg_view_duration_s, s.raw
       FROM publications p
       JOIN content c ON c.id = p.content_id
       JOIN analytics_snapshots s ON s.publication_id = p.id
      WHERE p.status = 'published' AND p.published_at >= $1 AND ($2 OR p.dry_run = false)`,
    [opts.since.toISOString(), opts.includeDryRun],
  );
  const best = new Map<string, any>();
  for (const r of res.rows) {
    const cur = best.get(r.pub_id);
    if (!cur || (CP_RANK[r.checkpoint] ?? 0) > (CP_RANK[cur.checkpoint] ?? 0)) best.set(r.pub_id, r);
  }
  return [...best.values()].map((r) => {
    const lengthS = Number(r.render?.durationS ?? r.script?.estimatedDurationS ?? 0);
    return {
      publicationId: r.pub_id,
      contentId: r.content_id,
      platform: r.platform,
      template: r.template,
      pillar: r.pillar,
      topic: r.topic,
      hookStyle: r.hook_style,
      lengthS,
      lengthBucket: lengthBucket(lengthS),
      hour: String(localParts(new Date(r.published_at), opts.tz).hour).padStart(2, "0"),
      checkpoint: r.checkpoint,
      views: Number(r.views ?? 0),
      likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, follows: r.follows,
      retentionPct: r.retention_pct,
      avgViewDurationS: r.avg_view_duration_s,
      ideaScores: r.idea?.scores ?? null,
      dryRun: r.dry_run,
      synthetic: r.raw?.synthetic === true,
      publishedAt: new Date(r.published_at),
    } as PerfRow;
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Performance score, centred on 0 ("about average for this platform"), roughly in [-3, +3]:
 *   views      = log2(views / platform median views)            clamped to ±3.3   weight 0.40
 *   engagement = log2(((likes + 2·comments + 3·shares + 3·saves + 5·follows) / views + 0.01) / 0.08)   ±3   weight 0.35
 *   retention  = (retention% − 50) / 25                          ±2                weight 0.25 (only if the platform reports it)
 * Components a platform doesn't report are skipped and the remaining weights renormalised, so e.g.
 * TikTok (no retention API) is judged on views + engagement only — never on made-up zeros.
 */
export function performanceScore(r: PerfRow, platformMedianViews: number): number {
  const parts: Array<[number, number]> = [];
  const rel = clamp(r.views / Math.max(1, platformMedianViews), 0.1, 10);
  parts.push([clamp(Math.log2(rel), -3.3, 3.3), 0.4]);
  const eng = (r.likes ?? 0) + 2 * (r.comments ?? 0) + 3 * (r.shares ?? 0) + 3 * (r.saves ?? 0) + 5 * (r.follows ?? 0);
  if (r.likes !== null || r.comments !== null || r.shares !== null || r.saves !== null || r.follows !== null) {
    parts.push([clamp(Math.log2((eng / Math.max(1, r.views) + 0.01) / 0.08), -3, 3), 0.35]);
  }
  if (r.retentionPct !== null && r.retentionPct !== undefined) parts.push([clamp((r.retentionPct - 50) / 25, -2, 2), 0.25]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return parts.reduce((s, [v, x]) => s + v * (x / w), 0);
}

export function scoreRows(rows: PerfRow[]): PerfRow[] {
  const byPlatform = new Map<string, number[]>();
  for (const r of rows) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r.views]);
  const med = new Map([...byPlatform].map(([p, v]) => [p, median(v)]));
  return rows.map((r) => ({ ...r, score: performanceScore(r, med.get(r.platform)!) }));
}

export interface Group {
  key: string;
  n: number;
  mean: number;
}

export function groupMean(rows: PerfRow[], keyFn: (r: PerfRow) => string | null): Group[] {
  const m = new Map<string, number[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || r.score === undefined) continue;
    m.set(k, [...(m.get(k) ?? []), r.score]);
  }
  return [...m].map(([key, xs]) => ({ key, n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length })).sort((a, b) => b.mean - a.mean);
}

/** Pulls a small-sample mean toward 0 (the prior "no effect"): n/(n+k). */
export const shrink = (mean: number, n: number, k = 5): number => mean * (n / (n + k));

/** Top-performing past posts, handed back to ideation as an "internal" signal. */
export async function topPerformingItems(db: Db, tz: string, includeDryRun = false, limit = 5): Promise<Array<{ topic: string; score: number; pillar: Pillar; template: Template }>> {
  const rows = scoreRows(await loadPerfRows(db, { since: new Date(Date.now() - 60 * 86400_000), includeDryRun, tz }));
  return rows
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((r) => (r.score ?? 0) > 0)
    .slice(0, limit)
    .map((r) => ({ topic: r.topic, score: Math.round((r.score ?? 0) * 100) / 100, pillar: r.pillar, template: r.template }));
}
