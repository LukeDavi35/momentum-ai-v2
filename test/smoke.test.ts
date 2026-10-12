import { describe, expect, it, vi } from "vitest";
import { runSmoke, smokeFailed } from "../src/ops/smoke.js";
import { checkLayout } from "../src/qa/policy.js";
import { DryRunPublisher } from "../src/publish/publishers/dryrun.js";
import { TokenStore } from "../src/publish/tokens.js";
import { makeDeps } from "./helpers.js";

const KEY = "ab".repeat(32);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

describe("live smoke test (read-only)", () => {
  async function setup(env: Record<string, string> = {}, routes: Array<[RegExp, () => Response]> = []) {
    const ctx = await makeDeps({ env: { ADMIN_TOKEN: "x", PUBLIC_BASE_URL: "https://a.test", TOKEN_ENC_KEY: KEY, MEDIA_SIGNING_SECRET: "s", ...env } });
    const calls: Array<{ url: string; method: string }> = [];
    const f = vi.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      const r = routes.find(([re]) => re.test(String(url)));
      if (!r) throw new Error(`unexpected ${url}`);
      return r[1]();
    });
    const tokens = new TokenStore(ctx.db, KEY, ctx.deps.log, ctx.deps.alerter, vi.fn() as any);
    return { ...ctx, f: f as any, calls, tokens };
  }

  it("skips unconfigured services, flags what live mode is missing, and never touches a publishing endpoint", async () => {
    const { deps, db, f, calls, tokens } = await setup();
    const checks = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by.postgres!.status).toBe("ok");
    expect(by["live-readiness"]!.status).toBe("fail");
    expect(by["live-readiness"]!.detail).toMatch(/ANTHROPIC_API_KEY/);
    expect(by.anthropic!.status).toBe("skipped");
    expect(by.tiktok!.status).toBe("fail"); // enabled but no account connected
    expect(by.tiktok!.detail).toMatch(/No tiktok account connected/);
    expect(smokeFailed(checks)).toBe(true);
    expect(calls).toEqual([]); // nothing configured -> nothing contacted
  });

  it("checks each connected account through READ-ONLY endpoints only", async () => {
    const { deps, db, f, calls, tokens } = await setup(
      { ANTHROPIC_API_KEY: "k", ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v1" },
      [
        [/api\.anthropic\.com\/v1\/models/, () => json({ data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }] })],
        [/elevenlabs\.io\/v1\/voices\/v1/, () => json({ name: "Adam" })],
        [/creator_info/, () => json({ data: { privacy_level_options: ["SELF_ONLY"] } })],
        [/content_publishing_limit/, () => json({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] })],
        [/youtube\/v3\/channels/, () => json({ items: [{ snippet: { title: "My Channel" } }] })],
      ],
    );
    const exp = new Date(Date.now() + 86400_000);
    await tokens.save("tiktok", { accessToken: "T", expiresAt: exp });
    await tokens.save("instagram", { accessToken: "I", accountId: "1784", expiresAt: exp });
    await tokens.save("youtube", { accessToken: "Y", expiresAt: exp });
    const checks = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by.anthropic!.detail).toMatch(/key valid/);
    expect(by.elevenlabs!.detail).toContain('"Adam"');
    expect(by.tiktok!.detail).toMatch(/private \(app not audited\)/); // the audit warning surfaces here
    expect(by.instagram!.detail).toContain("3/100");
    expect(by.youtube!.detail).toContain("My Channel");
    // the safety property: no upload/publish/create endpoint is ever called
    expect(calls.map((c) => c.url).join("\n")).not.toMatch(/video\/init|media_publish|\/media\?|uploadType|\/upload\//);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([expect.stringContaining("creator_info")]); // the lone POST is a read-only query
  });

  it("reports a Redis that does not answer as a FAILURE (never a pass)", async () => {
    const { deps, db, f, tokens } = await setup();
    const down = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f, redisPing: async () => false });
    expect(down.find((c) => c.name === "redis")).toMatchObject({ status: "fail" });
    expect(down.find((c) => c.name === "redis")!.detail).toMatch(/no answer/);
    const throwing = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f, redisPing: async () => { throw new Error("ECONNREFUSED"); } });
    expect(throwing.find((c) => c.name === "redis")).toMatchObject({ status: "fail", detail: "ECONNREFUSED" });
    const up = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f, redisPing: async () => true });
    expect(up.find((c) => c.name === "redis")).toMatchObject({ status: "ok", detail: "PONG" });
  });

  it("reports a bad key as a failure with the HTTP reason, and a failed alert delivery", async () => {
    const { deps, db, f, tokens } = await setup({ ANTHROPIC_API_KEY: "bad", DISCORD_WEBHOOK_URL: "https://discord.test/h" }, [[/anthropic/, () => new Response("invalid x-api-key", { status: 401 })], [/discord/, () => new Response("no", { status: 500 })]]);
    deps.alerter = new (await import("../src/safety/alerts.js")).Alerter(db, deps.cfg.env, deps.log, f);
    const checks = await runSmoke({ cfg: deps.cfg, db, tokens, fetchImpl: f, alerter: deps.alerter, sendTestAlert: true });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by.anthropic).toMatchObject({ status: "fail" });
    expect(by.anthropic!.detail).toContain("401");
    expect(by.alerts).toMatchObject({ status: "fail" });
    expect(by.alerts!.detail).toMatch(/delivery failed/);
  });
});

describe("layout guard", () => {
  const mk = (visual: any): any => ({ visual });
  it("flags on-screen text too long for the template, and passes normal text", () => {
    expect(checkLayout(mk({ headline: "Kipyegon breaks 1500m world record", stat: "3:49.04", items: ["Ran 3:49.04 in Paris"] }))).toEqual([]);
    const v = checkLayout(mk({ headline: "x".repeat(75), stat: "123456789012345", items: ["y".repeat(61)] }));
    expect(v.map((x) => x.excerpt.split(" ")[0])).toEqual(["headline", "stat", "item"]);
    expect(v.every((x) => x.rule === "layout")).toBe(true);
  });
});

describe("dry-run synthetic metrics", () => {
  it("accumulate across checkpoints and stay deterministic", async () => {
    const p = new DryRunPublisher("tiktok", "/tmp/x");
    const [a, b, c] = await Promise.all((["1h", "24h", "7d"] as const).map((checkpoint) => p.metrics("dryrun_abc", { checkpoint })));
    expect(a.views!).toBeLessThan(b.views!);
    expect(b.views!).toBeLessThan(c.views!);
    expect(await p.metrics("dryrun_abc", { checkpoint: "7d" })).toEqual(c);
  });
});

describe("stub scripts always fit the layout (guards the dry-run against the layout check)", () => {
  it("long, real-shaped headlines are cut at a word boundary under the limit", async () => {
    const { StubProvider } = await import("../src/llm/stub.js");
    const { checkLayout } = await import("../src/qa/policy.js");
    const headlines = [
      "Buccaneers explode in third quarter in win over Cowboys at Raymond James Stadium",
      "Extraordinarily-long-hyphenated-compound-words dominate championship preparations internationally",
      "Wimbledon boss jokes military would love to 'sort out' influencers",
    ];
    for (const topic of headlines) {
      const input: any = { template: "news_flash", pillar: "sports_news", topic, angle: "", hookStyle: "news", evergreen: false, feedback: null, lengthTarget: "", sources: [{ alias: "S1", id: "1", title: topic, summary: "A fairly ordinary sentence about the event that took place today. Another sentence follows it here.", body: "", kind: "news", source: "bbc", citable: true }] };
      const res = await new StubProvider().complete({ task: "script.write", model: "x", system: "", prompt: "", maxTokens: 1, input });
      const script = JSON.parse(res.text);
      expect(checkLayout(script), topic).toEqual([]);
      expect(script.visual.headline.length).toBeLessThanOrEqual(60);
    }
  });
});
