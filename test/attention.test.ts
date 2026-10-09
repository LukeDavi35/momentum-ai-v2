import { describe, expect, it } from "vitest";
import { computeAttention, verdict } from "../dashboard/src/attention.js";
import type { AlertRow, DlqRow, Overview, Spend } from "../dashboard/src/types.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const healthy = (over: Partial<Overview> = {}): Overview => ({
  dryRun: false,
  llm: "live",
  killSwitch: { active: false, source: null },
  pausedQueues: {},
  queues: { render: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 9, paused: false } },
  contentByStatus: { held: 0, failed: 0 },
  posts24h: 3,
  maxPostsPerDay: 9,
  alertChannels: ["discord"],
  connectedAccounts: ["tiktok", "instagram", "youtube"].map((platform) => ({ platform, account_name: "x", expires_at: new Date(NOW.getTime() + 30 * 86400_000).toISOString(), last_refresh_error: null })),
  ...over,
});
const spend = (over: Partial<Spend["summary"][number]> = {}): Spend => ({ currency: "USD", daily: [], summary: [{ provider: "anthropic", dailySpent: 0.5, dailyCap: 3, monthlySpent: 5, monthlyCap: 60, capped: false, ...over }] });
const none = { dlq: [] as DlqRow[], alerts: [] as AlertRow[] };

describe("dashboard verdict (what the owner reads once a week)", () => {
  it("says ALL GOOD when nothing needs attention", () => {
    const a = computeAttention(healthy(), spend(), none.dlq, none.alerts, NOW);
    expect(a).toEqual([]);
    expect(verdict(a)).toEqual({ label: "All good — nothing needs you", tone: "ok" });
  });

  it("a dry run is informational only and does not turn the verdict red", () => {
    const a = computeAttention(healthy({ dryRun: true, connectedAccounts: [], alertChannels: [] }), spend(), none.dlq, none.alerts, NOW);
    expect(a).toEqual([{ level: "info", text: expect.stringContaining("DRY RUN") }]);
    expect(verdict(a).tone).toBe("ok");
  });

  it("flags held items as 'needs a look' with the count", () => {
    const a = computeAttention(healthy({ contentByStatus: { held: 2, failed: 0 } }), spend(), none.dlq, none.alerts, NOW);
    expect(a[0]!.text).toMatch(/2 items are HELD/);
    expect(verdict(a).tone).toBe("warn");
  });

  it.each([
    ["the kill switch", healthy({ killSwitch: { active: true, source: "dashboard", reason: "drill" } }), /PAUSED by the kill switch/],
    ["a queue paused by a spend cap", healthy({ pausedQueues: { script: { provider: "anthropic", since: "x", reason: "cap" } } }), /Queue "script" is paused/],
    ["a failing token refresh", healthy({ connectedAccounts: [{ platform: "tiktok", account_name: "x", expires_at: null, last_refresh_error: "invalid_grant" }, ...healthy().connectedAccounts.slice(1)] }), /tiktok token refresh is failing/],
    ["no alert channel (you'd never be told)", healthy({ alertChannels: [] }), /No alert channel/],
  ])("is CRITICAL for %s", (_n, o, re) => {
    const a = computeAttention(o, spend(), none.dlq, none.alerts, NOW);
    expect(a.some((x) => x.level === "critical" && re.test(x.text))).toBe(true);
    expect(verdict(a).tone).toBe("bad");
  });

  it("warns at 80% of a spend cap and goes critical at the cap", () => {
    expect(computeAttention(healthy(), spend({ dailySpent: 2.5 }), [], [], NOW).some((x) => x.level === "warning" && /83% of a spend cap/.test(x.text))).toBe(true);
    expect(computeAttention(healthy(), spend({ capped: true }), [], [], NOW).some((x) => x.level === "critical")).toBe(true);
  });

  it("flags unconnected accounts and soon-to-expire tokens (live only)", () => {
    const o = healthy({ connectedAccounts: [{ platform: "youtube", account_name: "x", expires_at: new Date(NOW.getTime() + 86400_000).toISOString(), last_refresh_error: null }] });
    const text = computeAttention(o, spend(), [], [], NOW).map((x) => x.text).join("|");
    expect(text).toMatch(/tiktok is not connected/);
    expect(text).toMatch(/youtube token expires soon/);
  });

  it("only counts recent dead letters and recent critical alerts, and backlogs", () => {
    const old = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
    const recent = new Date(NOW.getTime() - 3600_000).toISOString();
    expect(computeAttention(healthy(), spend(), [{ queue: "qa", job_id: null, content_id: null, error: "x", attempts: 5, at: old }], [], NOW)).toEqual([]);
    const a = computeAttention(
      healthy({ queues: { render: { waiting: 80, active: 0, delayed: 0, failed: 0, completed: 0, paused: false } } }),
      spend(),
      [{ queue: "qa", job_id: null, content_id: null, error: "x", attempts: 5, at: recent }],
      [{ key: "k", severity: "critical", title: "Boom", body: "", channels: [], at: recent }],
      NOW,
    );
    const text = a.map((x) => x.text).join("|");
    expect(text).toMatch(/dead-lettered in the last 7 days/);
    expect(text).toMatch(/critical alert.*Boom/);
    expect(text).toMatch(/backlog of 80/);
  });
});
