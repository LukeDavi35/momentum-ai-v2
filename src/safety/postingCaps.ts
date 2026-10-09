import type { Db } from "../db/db.js";
import { effectiveMaxPostsPerDay, type AppConfig, type Platform } from "../config/index.js";

export class PostCapReached extends Error {
  constructor(public readonly scope: "global" | Platform, public readonly count: number, public readonly cap: number) {
    super(`Posting cap reached (${scope}): ${count}/${cap} in the last 24h`);
    this.name = "PostCapReached";
  }
}

/**
 * Rolling-24h counts. `publishing` rows count too, so an in-flight post can't be double-spent.
 * Dry-run and live posts are counted separately so a dry-run never blocks real posting (or vice versa).
 */
export async function postsInLast24h(db: Db, dryRun: boolean, platform?: Platform, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const res = platform
    ? await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM publications WHERE status IN ('published','publishing') AND dry_run = $1 AND platform = $2 AND COALESCE(published_at, updated_at) >= $3`,
        [dryRun, platform, since],
      )
    : await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM publications WHERE status IN ('published','publishing') AND dry_run = $1 AND COALESCE(published_at, updated_at) >= $2`,
        [dryRun, since],
      );
  return Number(res.rows[0]?.n ?? 0);
}

/** Enforces BOTH the global hard cap (env/limits, min of the two) and the per-platform cap from schedule.json. */
export async function assertCanPublish(db: Db, cfg: AppConfig, platform: Platform, now = new Date()): Promise<void> {
  const dry = cfg.env.DRY_RUN;
  const globalCap = effectiveMaxPostsPerDay(cfg);
  const global = await postsInLast24h(db, dry, undefined, now);
  if (global >= globalCap) throw new PostCapReached("global", global, globalCap);
  const platformCap = cfg.schedule.platforms[platform].postsPerDay;
  const perPlatform = await postsInLast24h(db, dry, platform, now);
  if (perPlatform >= platformCap) throw new PostCapReached(platform, perPlatform, platformCap);
}
