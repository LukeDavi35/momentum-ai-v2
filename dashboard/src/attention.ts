import type { AlertRow, DlqRow, Overview, Spend } from "./types.js";

export type Level = "critical" | "warning" | "info";
export interface Attention {
  level: Level;
  text: string;
}

const PLATFORMS = ["tiktok", "instagram", "youtube"];

/**
 * The "check it once a week" verdict. Pure function of the API data so it is unit-tested:
 * the dashboard's job is to say, unambiguously, whether anything needs the owner.
 */
export function computeAttention(o: Overview, spend: Spend | null, dlq: DlqRow[], alerts: AlertRow[], now = new Date()): Attention[] {
  const out: Attention[] = [];
  if (o.killSwitch.active) out.push({ level: "critical", text: `Publishing is PAUSED by the kill switch (${o.killSwitch.source}${o.killSwitch.reason ? `: ${o.killSwitch.reason}` : ""}).` });
  if (o.dryRun) out.push({ level: "info", text: "DRY RUN — nothing is being posted to any platform." });

  for (const [q, p] of Object.entries(o.pausedQueues)) out.push({ level: "critical", text: `Queue "${q}" is paused: ${p.reason}` });
  const held = o.contentByStatus.held ?? 0;
  if (held > 0) out.push({ level: "warning", text: `${held} item${held === 1 ? " is" : "s are"} HELD after failing QA and will not publish. See the Held tab for why.` });
  const failed = o.contentByStatus.failed ?? 0;
  if (failed > 0) out.push({ level: "warning", text: `${failed} item${failed === 1 ? "" : "s"} failed permanently (dead-lettered). See Alerts.` });

  for (const s of spend?.summary ?? []) {
    const frac = Math.max(s.dailyCap ? s.dailySpent / s.dailyCap : 0, s.monthlyCap ? s.monthlySpent / s.monthlyCap : 0);
    if (s.capped) out.push({ level: "critical", text: `${s.provider} hit its spend cap.` });
    else if (frac >= 0.8) out.push({ level: "warning", text: `${s.provider} is at ${Math.round(frac * 100)}% of a spend cap.` });
  }

  if (!o.dryRun) {
    for (const p of PLATFORMS) {
      const a = o.connectedAccounts.find((x) => x.platform === p);
      if (!a) out.push({ level: "warning", text: `${p} is not connected (see Setup).` });
      else if (a.last_refresh_error) out.push({ level: "critical", text: `${p} token refresh is failing: ${a.last_refresh_error.slice(0, 120)}` });
      else if (a.expires_at && new Date(a.expires_at).getTime() - now.getTime() < 3 * 86400_000) out.push({ level: "warning", text: `${p} token expires soon.` });
    }
    if (o.alertChannels.length === 0) out.push({ level: "critical", text: "No alert channel is configured — you would not be told about problems." });
  }

  const recentDlq = dlq.filter((d) => now.getTime() - new Date(d.at).getTime() < 7 * 86400_000);
  if (recentDlq.length > 0) out.push({ level: "warning", text: `${recentDlq.length} job${recentDlq.length === 1 ? "" : "s"} dead-lettered in the last 7 days (latest: ${recentDlq[0]!.queue}).` });
  const crit = alerts.filter((a) => a.severity === "critical" && now.getTime() - new Date(a.at).getTime() < 86400_000);
  if (crit.length > 0) out.push({ level: "warning", text: `${crit.length} critical alert${crit.length === 1 ? "" : "s"} in the last 24h: ${crit[0]!.title}` });
  for (const [q, c] of Object.entries(o.queues)) if (c.waiting > 50) out.push({ level: "warning", text: `Queue "${q}" has a backlog of ${c.waiting}.` });
  return out;
}

export const verdict = (a: Attention[]): { label: string; tone: "ok" | "warn" | "bad" } => {
  const real = a.filter((x) => x.level !== "info");
  if (real.some((x) => x.level === "critical")) return { label: "Needs attention now", tone: "bad" };
  if (real.length > 0) return { label: "Needs a look", tone: "warn" };
  return { label: "All good — nothing needs you", tone: "ok" };
};
