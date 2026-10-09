import type { Db } from "../db/db.js";
import { getSetting, setSetting } from "../db/settings.js";
import type { Alerter } from "./alerts.js";

export class KillSwitchActive extends Error {
  constructor(public readonly source: "env" | "dashboard", public readonly reason?: string) {
    super(`Kill switch active (${source})${reason ? `: ${reason}` : ""}`);
    this.name = "KillSwitchActive";
  }
}

export interface KillSwitchState {
  active: boolean;
  source: "env" | "dashboard" | null;
  reason?: string;
  since?: string;
  by?: string;
}

const KEY = "kill_switch";

/** Active if EITHER the env var is true OR the dashboard flag is on. Env wins and cannot be cleared from the dashboard. */
export async function getKillSwitch(db: Db, env: { KILL_SWITCH: boolean }): Promise<KillSwitchState> {
  if (env.KILL_SWITCH) return { active: true, source: "env", reason: "KILL_SWITCH=true in environment" };
  const v = await getSetting<{ active: boolean; reason?: string; since?: string; by?: string }>(db, KEY);
  if (v?.active) return { active: true, source: "dashboard", reason: v.reason, since: v.since, by: v.by };
  return { active: false, source: null };
}

export async function assertNotKilled(db: Db, env: { KILL_SWITCH: boolean }): Promise<void> {
  const s = await getKillSwitch(db, env);
  if (s.active) throw new KillSwitchActive(s.source!, s.reason);
}

export async function setKillSwitch(
  db: Db,
  alerter: Alerter | undefined,
  active: boolean,
  by: string,
  reason?: string,
): Promise<KillSwitchState> {
  await setSetting(db, KEY, { active, reason: reason ?? null, since: new Date().toISOString(), by }, by);
  await alerter?.send({
    key: `kill_switch:${active ? "on" : "off"}`,
    severity: active ? "critical" : "warning",
    title: active ? "KILL SWITCH ENGAGED — all publishing paused" : "Kill switch released — publishing may resume",
    body: `by ${by}${reason ? `: ${reason}` : ""}`,
    throttleMs: 0,
  });
  return { active, source: active ? "dashboard" : null, reason, by, since: new Date().toISOString() };
}
