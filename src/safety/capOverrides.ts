import type { Db } from "../db/db.js";
import { getSetting, setSetting } from "../db/settings.js";
import { effectiveMaxPostsPerDay, type AppConfig, type LimitsConfig, type SpendProvider } from "../config/index.js";
import type { Alerter } from "./alerts.js";

const KEY = "autonomy_cap_overrides";

export interface CapOverrides {
  maxPostsPerDay?: number;
  providers?: Partial<Record<SpendProvider, { daily?: number; monthly?: number }>>;
  updatedAt?: string;
  reason?: string;
  by?: string;
}

export async function getCapOverrides(db: Db): Promise<CapOverrides> {
  return (await getSetting<CapOverrides>(db, KEY)) ?? {};
}

/**
 * The live post cap: `config/limits.json` + `MAX_POSTS_PER_DAY` set the ceiling (unchanged — only editing
 * the file and restarting can raise it); an override can move the EFFECTIVE cap anywhere under that ceiling.
 */
export async function liveMaxPostsPerDay(db: Db, cfg: AppConfig): Promise<number> {
  const ceiling = effectiveMaxPostsPerDay(cfg);
  const o = await getCapOverrides(db);
  return o.maxPostsPerDay ? Math.min(o.maxPostsPerDay, ceiling) : ceiling;
}

/** Same ceiling model as `liveMaxPostsPerDay`, for one provider's spend caps. */
export async function liveSpendCap(db: Db, limits: LimitsConfig, provider: SpendProvider): Promise<{ daily: number; monthly: number }> {
  const ceiling = limits.providers[provider];
  if (!ceiling) throw new Error(`No spend limit configured for provider ${provider}`);
  const o = await getCapOverrides(db);
  const ov = o.providers?.[provider];
  return {
    daily: ov?.daily ? Math.min(ov.daily, ceiling.daily) : ceiling.daily,
    monthly: ov?.monthly ? Math.min(ov.monthly, ceiling.monthly) : ceiling.monthly,
  };
}

export interface CapPatch {
  maxPostsPerDay?: number;
  provider?: SpendProvider;
  daily?: number;
  monthly?: number;
}

/**
 * Used only by the autonomy agent (src/autonomy/agent.ts) to raise or lower a live cap. Every value is
 * clamped to its ceiling here too, so a bug upstream can never push an override past `limits.json` —
 * raising the ceiling itself still requires a human to edit the file and restart the worker. Always
 * reports the change through the alerter (severity "info") so this is never a silent edit.
 */
export async function setCapOverride(
  db: Db,
  alerter: Alerter | undefined,
  cfg: AppConfig,
  patch: CapPatch,
  reason: string,
  by = "autonomy-agent",
  now: Date = new Date(),
): Promise<CapOverrides> {
  const current = await getCapOverrides(db);
  const next: CapOverrides = { ...current, providers: { ...current.providers } };
  if (patch.maxPostsPerDay !== undefined) next.maxPostsPerDay = Math.min(patch.maxPostsPerDay, effectiveMaxPostsPerDay(cfg));
  if (patch.provider) {
    const ceiling = cfg.limits.providers[patch.provider];
    if (!ceiling) throw new Error(`No spend limit configured for provider ${patch.provider}`);
    const prev = current.providers?.[patch.provider];
    next.providers = {
      ...next.providers,
      [patch.provider]: {
        daily: patch.daily !== undefined ? Math.min(patch.daily, ceiling.daily) : prev?.daily,
        monthly: patch.monthly !== undefined ? Math.min(patch.monthly, ceiling.monthly) : prev?.monthly,
      },
    };
  }
  next.updatedAt = now.toISOString();
  next.reason = reason;
  next.by = by;
  await setSetting(db, KEY, next, by);
  await alerter?.send({
    key: `autonomy_cap:${patch.provider ?? "posts"}:${now.toISOString().slice(0, 10)}`,
    severity: "info",
    title: `Autonomy agent adjusted a ${patch.provider ? `${patch.provider} spend` : "posts/day"} cap`,
    body: `${reason}\n${JSON.stringify(patch)}`,
    throttleMs: 0,
  });
  return next;
}
