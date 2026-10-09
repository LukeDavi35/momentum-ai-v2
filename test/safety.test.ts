import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/db.js";
import { Alerter } from "../src/safety/alerts.js";
import { assertNotKilled, getKillSwitch, KillSwitchActive, setKillSwitch } from "../src/safety/killswitch.js";
import { SpendCapExceeded, SpendTracker } from "../src/safety/spend.js";
import { assertCanPublish, PostCapReached, postsInLast24h } from "../src/safety/postingCaps.js";
import { silentLogger, testConfig, testDb } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const envOf = (o: Record<string, string> = {}) => testConfig(o).env;

describe("kill switch", () => {
  it("is off by default", async () => {
    expect((await getKillSwitch(db, envOf())).active).toBe(false);
    await expect(assertNotKilled(db, envOf())).resolves.toBeUndefined();
  });

  it("env var activates it and cannot be bypassed by the dashboard flag being off", async () => {
    const env = envOf({ KILL_SWITCH: "true" });
    const s = await getKillSwitch(db, env);
    expect(s).toMatchObject({ active: true, source: "env" });
    await expect(assertNotKilled(db, env)).rejects.toBeInstanceOf(KillSwitchActive);
  });

  it("dashboard toggle activates and releases it, and alerts on both", async () => {
    const sent: any[] = [];
    const alerter = { send: async (a: any) => void sent.push(a) } as unknown as Alerter;
    await setKillSwitch(db, alerter, true, "dashboard", "testing");
    expect(await getKillSwitch(db, envOf())).toMatchObject({ active: true, source: "dashboard", reason: "testing" });
    await expect(assertNotKilled(db, envOf())).rejects.toThrow(/Kill switch active/);
    await setKillSwitch(db, alerter, false, "dashboard");
    expect((await getKillSwitch(db, envOf())).active).toBe(false);
    expect(sent.map((a) => a.severity)).toEqual(["critical", "warning"]);
    expect(sent.every((a) => a.throttleMs === 0)).toBe(true); // kill-switch alerts are never throttled
  });
});

describe("spend caps", () => {
  const cfg = testConfig();
  const mk = (now = new Date("2026-10-09T12:00:00Z")) => new SpendTracker(db, cfg.limits, cfg.pricing, () => now);

  it("passes under the cap and throws SpendCapExceeded (with the queues to pause) over the daily cap", async () => {
    const t = mk();
    await t.guard("anthropic", 0.5);
    await t.record({ provider: "anthropic", category: "llm", usd: 2.9 });
    await t.guard("anthropic", 0.05); // 2.95 < 3
    await expect(t.guard("anthropic", 0.2)).rejects.toMatchObject({ name: "SpendCapExceeded", window: "daily", queues: ["ideate", "script", "qa"] });
  });

  it("enforces the monthly cap even when today is fine", async () => {
    const t = mk(new Date("2026-10-25T12:00:00Z"));
    // 20 prior days at $2.95 (under the $3 daily cap) = $59 this month
    for (let d = 1; d <= 20; d++) {
      await db.query(`INSERT INTO spend_ledger (provider, category, usd, at) VALUES ('anthropic','llm',2.95,$1)`, [`2026-10-${String(d).padStart(2, "0")}T10:00:00Z`]);
    }
    await expect(t.guard("anthropic", 0)).resolves.toBeUndefined();
    await expect(t.guard("anthropic", 1.5)).rejects.toMatchObject({ window: "monthly" });
  });

  it("a cap of 0 blocks the provider entirely", async () => {
    const limits = { ...cfg.limits, providers: { ...cfg.limits.providers, render: { daily: 0, monthly: 0 } } };
    await expect(new SpendTracker(db, limits, cfg.pricing).guard("render", 0.0001)).rejects.toBeInstanceOf(SpendCapExceeded);
  });

  it("previous days do not count toward today's cap", async () => {
    const t = mk();
    await db.query(`INSERT INTO spend_ledger (provider, category, usd, at) VALUES ('elevenlabs','tts',1.9,'2026-10-08T23:59:00Z')`);
    await expect(t.guard("elevenlabs", 1.5)).resolves.toBeUndefined();
  });

  it("estimates costs and summarises vs caps", async () => {
    const t = mk();
    expect(t.llmCost("claude-sonnet-5", 1_000_000, 100_000)).toBeCloseTo(3 + 1.5, 5);
    expect(t.llmCost("some-unknown-model", 1_000_000, 0)).toBe(15); // falls back to the conservative default
    expect(t.ttsCost("elevenlabs", 1000)).toBeCloseTo(0.3, 5);
    await t.record({ provider: "render", category: "video", usd: 1 });
    const summary = await t.summary();
    const render = summary.find((s) => s.provider === "render")!;
    expect(render).toMatchObject({ dailySpent: 1, dailyCap: 1, capped: true });
  });
});

describe("alerter", () => {
  const baseEnv = { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined, GENERIC_WEBHOOK_URL: undefined, SMTP_URL: undefined, ALERT_EMAIL_TO: undefined, ALERT_EMAIL_FROM: undefined, DRY_RUN: false };

  it("delivers to configured channels and persists the alert", async () => {
    const calls: Array<[string, any]> = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      calls.push([String(url), JSON.parse(init.body)]);
      return new Response("ok", { status: 200 });
    });
    const mails: any[] = [];
    const alerter = new Alerter(
      db,
      { ...baseEnv, DISCORD_WEBHOOK_URL: "https://discord.test/hook", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", SMTP_URL: "smtp://x", ALERT_EMAIL_TO: "me@x.test" },
      silentLogger(),
      fetchImpl as any,
      { sendMail: async (m) => void mails.push(m) },
    );
    const r = await alerter.send({ key: "k1", severity: "critical", title: "Boom", body: "details" });
    expect(r.channels.sort()).toEqual(["discord", "email", "telegram"]);
    expect(calls.find(([u]) => u.includes("discord"))![1].content).toContain("Boom");
    expect(calls.find(([u]) => u.includes("api.telegram.org/botT/sendMessage"))![1]).toMatchObject({ chat_id: "42" });
    expect(mails[0].subject).toContain("Boom");
    expect((await db.query(`SELECT * FROM alerts_log`)).rowCount).toBe(1);
  });

  it("throttles repeats of the same key but never throttles when throttleMs is 0", async () => {
    const alerter = new Alerter(db, baseEnv, silentLogger());
    expect((await alerter.send({ key: "dup", severity: "warning", title: "t" })).suppressed).toBe(false);
    expect((await alerter.send({ key: "dup", severity: "warning", title: "t" })).suppressed).toBe(true);
    expect((await alerter.send({ key: "other", severity: "warning", title: "t" })).suppressed).toBe(false);
    expect((await alerter.send({ key: "dup", severity: "critical", title: "t", throttleMs: 0 })).suppressed).toBe(false);
  });

  it("never throws when a channel fails, and still reports the channels that worked", async () => {
    const fetchImpl = vi.fn(async (url: any) => (String(url).includes("bad") ? new Response("no", { status: 500 }) : new Response("ok")));
    const alerter = new Alerter(db, { ...baseEnv, DISCORD_WEBHOOK_URL: "https://bad.test", GENERIC_WEBHOOK_URL: "https://good.test" }, silentLogger(), fetchImpl as any);
    const r = await alerter.send({ key: "x", severity: "critical", title: "t" });
    expect(r.channels).toEqual(["webhook"]);
  });
});

describe("posting caps", () => {
  async function addPub(platform: string, status: string, dry: boolean, publishedAt: Date) {
    await db.query(
      `INSERT INTO publications (id, content_id, platform, status, published_at, dry_run) VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, $4)`,
      [platform, status, publishedAt.toISOString(), dry],
    );
  }
  const now = new Date("2026-10-09T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);

  it("blocks at the global hard cap regardless of schedule config", async () => {
    const cfg = testConfig({ MAX_POSTS_PER_DAY: "2" });
    await addPub("tiktok", "published", true, hoursAgo(1));
    await addPub("youtube", "published", true, hoursAgo(2));
    await expect(assertCanPublish(db, cfg, "instagram", now)).rejects.toMatchObject({ scope: "global", cap: 2 });
  });

  it("uses the stricter of MAX_POSTS_PER_DAY and limits.json", async () => {
    const cfg = testConfig({ MAX_POSTS_PER_DAY: "500" }); // limits.json says 9
    for (let i = 0; i < 9; i++) await addPub(["tiktok", "instagram", "youtube"][i % 3]!, "published", true, hoursAgo(i + 0.5));
    await expect(assertCanPublish(db, cfg, "tiktok", now)).rejects.toMatchObject({ scope: "global", cap: 9 });
  });

  it("enforces the per-platform postsPerDay and ignores posts older than 24h", async () => {
    const cfg = testConfig();
    for (let i = 0; i < 3; i++) await addPub("tiktok", "published", true, hoursAgo(i + 1));
    await expect(assertCanPublish(db, cfg, "tiktok", now)).rejects.toMatchObject({ scope: "tiktok" });
    await expect(assertCanPublish(db, cfg, "youtube", now)).resolves.toBeUndefined();
    await db.query(`DELETE FROM publications`);
    for (let i = 0; i < 3; i++) await addPub("tiktok", "published", true, hoursAgo(25 + i));
    await expect(assertCanPublish(db, cfg, "tiktok", now)).resolves.toBeUndefined();
  });

  it("counts in-flight `publishing` rows so a concurrent post cannot double-spend the cap", async () => {
    const cfg = testConfig();
    for (let i = 0; i < 3; i++) await addPub("youtube", "publishing", true, hoursAgo(1));
    await expect(assertCanPublish(db, cfg, "youtube", now)).rejects.toBeInstanceOf(PostCapReached);
  });

  it("keeps dry-run and live counts separate", async () => {
    for (let i = 0; i < 3; i++) await addPub("tiktok", "published", true, hoursAgo(1));
    expect(await postsInLast24h(db, true, undefined, now)).toBe(3);
    expect(await postsInLast24h(db, false, undefined, now)).toBe(0);
    await expect(assertCanPublish(db, testConfig({ DRY_RUN: "false" }), "tiktok", now)).resolves.toBeUndefined();
  });
});
