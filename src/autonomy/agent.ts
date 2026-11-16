import type { Db } from "../db/db.js";
import { getCapOverrides, setCapOverride } from "../safety/capOverrides.js";
import { getFastAdapt, setFastAdapt } from "./fastAdapt.js";
import type { Deps } from "../queue/types.js";

export interface AutonomyResult {
  capsRaised: string[];
  fastAdaptEnabled: boolean;
  notes: string[];
}

const RAISE_STEP = 0.1; // +10% per raise
const RAISE_HEADROOM = 0.7; // only raise a cap if trailing use stayed under 70% of it
const COOLDOWN_DAYS = 7; // at most one cap change per week, regardless of how often this job runs

const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000);
const daysSince = (now: Date, iso?: string): number => (iso ? (now.getTime() - new Date(iso).getTime()) / 86_400_000 : Infinity);

async function last7dAvgDailySpend(db: Db, provider: string, now: Date): Promise<number> {
  const r = await db.query<{ s: number | null }>(`SELECT COALESCE(SUM(usd), 0) AS s FROM spend_ledger WHERE provider = $1 AND at >= $2`, [provider, daysBefore(now, 7).toISOString()]);
  return Number(r.rows[0]?.s ?? 0) / 7;
}

async function last7dAvgDailyPosts(db: Db, dryRun: boolean, now: Date): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM publications WHERE status = 'published' AND dry_run = $1 AND published_at >= $2`, [dryRun, daysBefore(now, 7).toISOString()]);
  return Number(r.rows[0]?.n ?? 0) / 7;
}

async function recentlyHitSpendCap(db: Db, now: Date, days = COOLDOWN_DAYS): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM alerts_log WHERE key LIKE 'spend_cap:%' AND suppressed = false AND at >= $1 LIMIT 1`, [daysBefore(now, days).toISOString()]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Account/connection health is otherwise its own alert (src/publish/tokens.ts's `token_refresh_failed:<platform>`,
 * fired by the existing "refresh-tokens" job) - this doesn't add new OAuth logic, it just folds an unresolved
 * one into this run's notes so it shows up alongside any cap/strategy change in one place.
 */
async function unresolvedTokenFailures(db: Db, now: Date): Promise<string[]> {
  const r = await db.query<{ key: string }>(`SELECT DISTINCT key FROM alerts_log WHERE key LIKE 'token_refresh_failed:%' AND suppressed = false AND at >= $1`, [daysBefore(now, 1).toISOString()]);
  return r.rows.map((x) => x.key.split(":")[1]!);
}

/** Fraction of content held in a past window, or null if there isn't enough QA-concluded volume yet to mean anything. */
async function holdRate(db: Db, now: Date, fromDaysAgo: number, toDaysAgo: number): Promise<number | null> {
  const r = await db.query<{ held: number; total: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'held')::int AS held, COUNT(*)::int AS total
       FROM content
      WHERE status_changed_at >= $1
        AND status_changed_at < $2
        AND status IN ('held', 'published', 'measured', 'qa_passed', 'scheduled', 'publishing')`,
    [daysBefore(now, fromDaysAgo).toISOString(), daysBefore(now, toDaysAgo).toISOString()],
  );
  const total = Number(r.rows[0]?.total ?? 0);
  return total >= 5 ? Number(r.rows[0]?.held ?? 0) / total : null;
}

/** Gate for both raising a cap and enabling fast-adapt learning: no recent spend-cap hit, and QA isn't holding more than it used to. */
async function healthy(db: Db, now: Date): Promise<{ ok: boolean; reason?: string }> {
  if (await recentlyHitSpendCap(db, now)) return { ok: false, reason: "a spend cap was hit in the last 7 days" };
  const recent = await holdRate(db, now, 7, 0);
  const baseline = await holdRate(db, now, 14, 7);
  if (recent === null || baseline === null) return { ok: false, reason: "not enough recent QA history yet" };
  if (recent > baseline * 1.5) return { ok: false, reason: `QA hold-rate rose (${Math.round(recent * 100)}% vs a ${Math.round(baseline * 100)}% baseline)` };
  return { ok: true };
}

/**
 * The autonomy agent: runs frequently (see src/queue/scheduler.ts's "autonomy-agent" job) but only ever
 * changes a cap or the learning mode at most once a week per the cooldowns/health gate below, and never
 * past the ceilings in config/limits.json / config/schedule.json — those still need a human edit + restart.
 * Every change it makes goes out through the alerter (src/safety/capOverrides.ts, src/autonomy/fastAdapt.ts),
 * so none of this is silent.
 */
export async function runAutonomyAgent(deps: Deps): Promise<AutonomyResult> {
  const { db, cfg, log, alerter } = deps;
  const now = deps.now();
  const notes: string[] = [];
  const capsRaised: string[] = [];
  const health = await healthy(db, now);
  if (!health.ok) notes.push(`caps/fast-adapt unchanged this run: ${health.reason}`);
  const tokenFailures = await unresolvedTokenFailures(db, now);
  if (tokenFailures.length) notes.push(`account connection: ${tokenFailures.join(", ")} still failing to refresh - reconnect from the dashboard (see RUNBOOK.md section 4)`);

  const overrides = await getCapOverrides(db);
  const cooldownOk = daysSince(now, overrides.updatedAt) >= COOLDOWN_DAYS;

  if (health.ok && cooldownOk) {
    // --- posting cap -----------------------------------------------------
    const postCeiling = cfg.limits.maxPostsPerDay;
    const currentPostCap = overrides.maxPostsPerDay ?? Math.min(cfg.env.MAX_POSTS_PER_DAY, postCeiling);
    const avgPosts = await last7dAvgDailyPosts(db, cfg.env.DRY_RUN, now);
    if (currentPostCap < postCeiling && avgPosts > 0 && avgPosts / currentPostCap < RAISE_HEADROOM) {
      const next = Math.min(postCeiling, Math.ceil(currentPostCap * (1 + RAISE_STEP)));
      if (next > currentPostCap) {
        await setCapOverride(
          db,
          alerter,
          cfg,
          { maxPostsPerDay: next },
          `7-day average posts/day (${avgPosts.toFixed(1)}) stayed under ${Math.round(RAISE_HEADROOM * 100)}% of the cap (${currentPostCap}); raising to ${next} (ceiling ${postCeiling}).`,
          undefined,
          now,
        );
        capsRaised.push(`maxPostsPerDay ${currentPostCap}->${next}`);
      }
    }

    // --- spend caps --------------------------------------------------------
    for (const provider of Object.keys(cfg.limits.providers) as Array<keyof typeof cfg.limits.providers>) {
      const ceiling = cfg.limits.providers[provider]!;
      const ov = overrides.providers?.[provider];
      const currentDaily = ov?.daily ?? ceiling.daily;
      const avgSpend = await last7dAvgDailySpend(db, provider, now);
      if (currentDaily < ceiling.daily && avgSpend > 0 && avgSpend / currentDaily < RAISE_HEADROOM) {
        const nextDaily = Math.min(ceiling.daily, Math.round(currentDaily * (1 + RAISE_STEP) * 100) / 100);
        if (nextDaily > currentDaily) {
          await setCapOverride(
            db,
            alerter,
            cfg,
            { provider, daily: nextDaily },
            `7-day average ${provider} spend/day ($${avgSpend.toFixed(3)}) stayed under ${Math.round(RAISE_HEADROOM * 100)}% of the cap ($${currentDaily}); raising to $${nextDaily} (ceiling $${ceiling.daily}).`,
            undefined,
            now,
          );
          capsRaised.push(`${provider}.daily $${currentDaily}->$${nextDaily}`);
        }
      }
    }
  }

  // --- fast-adapt learning -------------------------------------------------
  const fastAdapt = await getFastAdapt(db);
  if (health.ok && !fastAdapt.enabled) {
    await setFastAdapt(db, alerter, true, "QA hold-rate has been stable and no spend cap has been hit recently; widening how much the weekly learning job can move strategy.");
  } else if (!health.ok && fastAdapt.enabled && health.reason !== "not enough recent QA history yet") {
    await setFastAdapt(db, alerter, false, `Reverting to the conservative learning bounds: ${health.reason}.`);
  }

  if (notes.length) log.info({ notes, capsRaised }, "autonomy agent run");
  return { capsRaised, fastAdaptEnabled: (await getFastAdapt(db)).enabled, notes };
}
