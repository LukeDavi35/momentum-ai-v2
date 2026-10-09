import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentWeights, saveWeights } from "../ideate/weights.js";
import type { Deps } from "../queue/types.js";
import { loadPerfRows, scoreRows } from "./performance.js";
import { renderWeeklyReport } from "./report.js";
import { computeNewWeights } from "./update.js";

export interface LearningResult {
  rows: number;
  changes: number;
  persisted: boolean;
  weightVersion?: number;
  reportPath: string;
  skipped?: string;
}

/**
 * Weekly job: measure → update weights → write WEEKLY_REPORT.md.
 * In DRY_RUN the analytics are synthetic, so the update is computed and reported but NEVER saved —
 * fake numbers must not steer a live account's strategy after the switch to live.
 */
export async function runWeeklyLearning(deps: Deps, opts: { reportDir?: string; windowDays?: number } = {}): Promise<LearningResult> {
  const { db, cfg, log } = deps;
  const now = deps.now();
  const windowDays = opts.windowDays ?? 28;
  const since = new Date(now.getTime() - windowDays * 86400_000);
  const dry = cfg.env.DRY_RUN;

  const rows = scoreRows(await loadPerfRows(db, { since, includeDryRun: dry, tz: cfg.schedule.timezone }));
  const current = await getCurrentWeights(db);
  const update = computeNewWeights(current.weights, rows);

  let weightVersion: number | undefined;
  const persist = !dry && update.changes.length > 0 && !update.skipped;
  if (persist) {
    const top = [...update.changes].sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 3);
    weightVersion = await saveWeights(db, update.weights, `weekly learning from ${update.rows} posts: ${top.map((c) => `${c.dimension}.${c.key} ${c.from}→${c.to}`).join(", ")}`, "auto");
  }

  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const c = await db.query<{ created: number; published: number; held: number; failed: number }>(
    `SELECT COUNT(*) FILTER (WHERE created_at >= $1)::int AS created,
            COUNT(*) FILTER (WHERE status IN ('published','measured') AND status_changed_at >= $1)::int AS published,
            COUNT(*) FILTER (WHERE status = 'held')::int AS held,
            COUNT(*) FILTER (WHERE status = 'failed' AND status_changed_at >= $1)::int AS failed
       FROM content`,
    [weekAgo],
  );
  const q = await db.query<{ passed: number; total: number }>(`SELECT COUNT(*) FILTER (WHERE passed)::int AS passed, COUNT(*)::int AS total FROM qa_results WHERE created_at >= $1`, [weekAgo]);
  const qaTotal = Number(q.rows[0]?.total ?? 0);

  const md = renderWeeklyReport({
    periodStart: new Date(now.getTime() - 7 * 86400_000),
    periodEnd: now,
    rows,
    changes: update.changes,
    skipped: update.skipped,
    persisted: persist,
    weightVersion,
    dryRun: dry,
    syntheticData: rows.some((r) => r.synthetic),
    counts: { ...c.rows[0]!, qaPassRate: qaTotal ? Number(q.rows[0]!.passed) / qaTotal : null },
    spend: await deps.spend.summary(),
  });
  const dir = opts.reportDir ?? cfg.env.REPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "WEEKLY_REPORT.md");
  writeFileSync(reportPath, md);
  writeFileSync(join(dir, `weekly-${now.toISOString().slice(0, 10)}.md`), md); // history of every report
  log.info({ rows: update.rows, changes: update.changes.length, persisted: persist, weightVersion, reportPath }, "weekly learning done");
  return { rows: update.rows, changes: update.changes.length, persisted: persist, weightVersion, reportPath, skipped: update.skipped };
}
