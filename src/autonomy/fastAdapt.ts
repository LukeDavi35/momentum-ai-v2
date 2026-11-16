import type { Db } from "../db/db.js";
import { getSetting, setSetting } from "../db/settings.js";
import type { Alerter } from "../safety/alerts.js";

const KEY = "autonomy_fast_adapt";

export interface FastAdaptState {
  enabled: boolean;
  since?: string;
  reason?: string;
}

/** Off by default. The autonomy agent (src/autonomy/agent.ts) is the only thing allowed to flip this. */
export async function getFastAdapt(db: Db): Promise<FastAdaptState> {
  return (await getSetting<FastAdaptState>(db, KEY)) ?? { enabled: false };
}

export async function setFastAdapt(db: Db, alerter: Alerter | undefined, enabled: boolean, reason: string, by = "autonomy-agent"): Promise<void> {
  const current = await getFastAdapt(db);
  if (current.enabled === enabled) return; // already in this state - nothing to report
  await setSetting(db, KEY, { enabled, since: new Date().toISOString(), reason }, by);
  await alerter?.send({
    key: `autonomy_fast_adapt:${enabled ? "on" : "off"}`,
    severity: enabled ? "info" : "warning",
    title: `Autonomy agent turned fast-adapt learning ${enabled ? "ON" : "OFF"}`,
    body: reason,
    throttleMs: 0,
  });
}
