import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type ApiContext } from "../src/api/server.js";
import { createContent, transition } from "../src/db/content.js";
import { signedMediaUrl } from "../src/publish/mediaHost.js";
import { makeState } from "../src/publish/oauth.js";
import { TokenStore } from "../src/publish/tokens.js";
import { makeDeps } from "./helpers.js";

const TOKEN = "t".repeat(40);
const KEY = "ab".repeat(32);
let server: Server | undefined;
afterEach(() => void server?.close());

async function boot(env: Record<string, string> = {}, extra: Partial<ApiContext> = {}) {
  const ctx = await makeDeps({ env: { ADMIN_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://app.test", TOKEN_ENC_KEY: KEY, MEDIA_SIGNING_SECRET: "sekrit", TIKTOK_CLIENT_KEY: "tk", TIKTOK_CLIENT_SECRET: "ts", ...env } });
  const tokens = new TokenStore(ctx.db, KEY, ctx.deps.log, ctx.deps.alerter, vi.fn() as any);
  const app = createApp({ deps: ctx.deps, tokens, dashboardDir: "/nonexistent", ...extra });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token: string | null = TOKEN) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (path: string, body: unknown, token: string | null = TOKEN) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { ...ctx, base, get, post, tokens };
}

describe("auth + health", () => {
  it("/healthz needs no auth, and reports 503 when Redis is down", async () => {
    const ok = await boot({}, { pingRedis: async () => true });
    expect(await (await ok.get("/healthz", null)).json()).toEqual({ ok: true, db: true, redis: true });
    server!.close();
    const down = await boot({}, { pingRedis: async () => false });
    const r = await down.get("/healthz", null);
    expect(r.status).toBe(503);
    expect((await r.json()).redis).toBe(false);
  });

  it("every /api route rejects a missing or wrong token and accepts the right one", async () => {
    const { get } = await boot();
    for (const p of ["/api/overview", "/api/content", "/api/held", "/api/publications", "/api/analytics", "/api/spend", "/api/weights", "/api/alerts", "/api/dlq"]) {
      expect((await get(p, null)).status, p).toBe(401);
      expect((await get(p, "wrong".repeat(10))).status, p).toBe(401);
      expect((await get(p)).status, p).toBe(200);
    }
  });

  it("the kill switch cannot be toggled without the token", async () => {
    const { post, get } = await boot();
    expect((await post("/api/killswitch", { active: true }, null)).status).toBe(401);
    expect((await (await get("/api/overview")).json()).killSwitch.active).toBe(false);
  });

  it("locks out brute-force attempts with 429", async () => {
    const { get } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await get("/api/overview", `bad${i}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(21)).toContain(429);
  });

  it("with no ADMIN_TOKEN: open in dry-run (local convenience), refused when live", async () => {
    const dry = await boot({ ADMIN_TOKEN: "" });
    expect((await dry.get("/api/overview", null)).status).toBe(200);
    server!.close();
    const live = await boot({ ADMIN_TOKEN: "", DRY_RUN: "false" });
    expect((await live.get("/api/overview", null)).status).toBe(503);
  });
});

describe("kill switch via the dashboard", () => {
  it("validates the body, engages, shows in the overview, alerts, and releases", async () => {
    const { post, get, db } = await boot();
    expect((await post("/api/killswitch", { active: "yes" })).status).toBe(400);
    const on = await (await post("/api/killswitch", { active: true, reason: "testing" })).json();
    expect(on).toMatchObject({ active: true, source: "dashboard", reason: "testing" });
    expect((await (await get("/api/overview")).json()).killSwitch.active).toBe(true);
    expect((await db.query(`SELECT severity FROM alerts_log WHERE key = 'kill_switch:on'`)).rows[0].severity).toBe("critical");
    const off = await (await post("/api/killswitch", { active: false })).json();
    expect(off.active).toBe(false);
  });

  it("an env KILL_SWITCH shows as active and cannot be cleared from the dashboard", async () => {
    const { post } = await boot({ KILL_SWITCH: "true" });
    const r = await (await post("/api/killswitch", { active: false })).json();
    expect(r).toMatchObject({ active: true, source: "env" });
  });
});

describe("content, held, overview", () => {
  it("lists content with filters, rejects bad filters, and hides embeddings in detail", async () => {
    const { get, db } = await boot();
    const c = await createContent(db, { pillar: "running", template: "news_flash", topic: "Hello", idea: {}, sourceItemIds: [], embedding: { model: "m", vector: [1, 2] } });
    expect(await (await get("/api/content?status=idea")).json()).toHaveLength(1);
    expect(await (await get("/api/content?status=published")).json()).toHaveLength(0);
    expect((await get("/api/content?status=bogus")).status).toBe(400);
    const d = await (await get(`/api/content/${c.id}`)).json();
    expect(d.topic).toBe("Hello");
    expect(d.embedding).toBeUndefined();
    expect(d.events).toHaveLength(1);
    // contract with the dashboard's ContentDetail type: snake_case, same as the list endpoint (a camelCase detail crashed the drawer)
    expect(d).toMatchObject({ id: c.id, correlation_id: c.correlationId, regen_count: 0, hook_style: null, status: "idea", script: null, qaResults: [], publications: [] });
    expect(Object.keys(d)).not.toContain("correlationId");
    const listRow = (await (await get("/api/content?status=idea")).json())[0];
    for (const k of Object.keys(listRow).filter((k) => !["generator", "voice_provider", "dev_voice"].includes(k))) expect(d, `detail is missing list field ${k}`).toHaveProperty(k);
    expect((await get("/api/content/not-a-uuid")).status).toBe(400);
    expect((await get("/api/content/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("shows held items with their QA failure reasons and reviewer feedback", async () => {
    const { get, db } = await boot();
    const c = await createContent(db, { pillar: "running", template: "news_flash", topic: "Held one", idea: {}, sourceItemIds: [] });
    await db.query(`UPDATE content SET status = 'held', regen_count = 2, error = 'QA failed after 3 attempts', qa = $2::jsonb WHERE id = $1`, [c.id, JSON.stringify({ failures: [{ kind: "factual", reason: "claim c2 unverified" }], reviewerFeedback: ["Open with the number."], scores: null })]);
    const [h] = await (await get("/api/held")).json();
    expect(h).toMatchObject({ topic: "Held one", attempts: 3, reason: "QA failed after 3 attempts", failures: [{ kind: "factual", reason: "claim c2 unverified" }], reviewerFeedback: ["Open with the number."] });
  });

  it("overview reports mode, caps and per-status counts", async () => {
    const { get } = await boot();
    const o = await (await get("/api/overview")).json();
    expect(o).toMatchObject({ dryRun: true, maxPostsPerDay: 9, posts24h: 0 });
    expect(o.contentByStatus.held).toBe(0);
    expect(o.llm).toMatch(/stub/);
  });

  it("spend, weights, alerts, analytics endpoints return sensible shapes", async () => {
    const { get, db } = await boot();
    await db.query(`INSERT INTO spend_ledger (provider, category, usd) VALUES ('anthropic','x',0.5)`);
    const spend = await (await get("/api/spend")).json();
    expect(spend.summary.find((s: any) => s.provider === "anthropic").dailySpent).toBeCloseTo(0.5);
    expect(await (await get("/api/weights")).json()).toEqual([]); // none seeded until bootstrap
    expect(Array.isArray(await (await get("/api/alerts")).json())).toBe(true);
    const a = await (await get("/api/analytics?days=7")).json();
    expect(a).toMatchObject({ dryRun: true, synthetic: true, series: [], top: [] });
  });
});

describe("weekly report endpoint", () => {
  it("returns null before the first report and the markdown after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    const b = await boot({ REPORT_DIR: dir });
    expect(await (await b.get("/api/report")).json()).toEqual({ markdown: null, updatedAt: null });
    writeFileSync(join(dir, "WEEKLY_REPORT.md"), "# Weekly report\n\nAll fine.");
    const r = await (await b.get("/api/report")).json();
    expect(r.markdown).toContain("All fine.");
    expect(r.updatedAt).toBeTruthy();
    expect((await b.get("/api/report", null)).status).toBe(401);
  });
});

describe("dashboard static serving", () => {
  it("never caches index.html (a cached copy pins users to a stale bundle) but caches hashed assets forever, with SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>app</html>");
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
    const b = await boot({}, { dashboardDir: dir });
    const home = await fetch(`${b.base}/`);
    expect(await home.text()).toContain("app");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    const spa = await fetch(`${b.base}/some/client/route`);
    expect(await spa.text()).toContain("app");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${b.base}/assets/index-abc123.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${b.base}/api/nope`)).status).not.toBe(200); // the SPA fallback must not swallow API paths
  });
});

describe("signed media", () => {
  async function withVideo() {
    const b = await boot();
    const dir = mkdtempSync(join(tmpdir(), "m-"));
    const video = join(dir, "v.mp4");
    writeFileSync(video, Buffer.from("0123456789"));
    const c = await createContent(b.db, { pillar: "running", template: "news_flash", topic: "t", idea: {}, sourceItemIds: [] });
    await transition(b.db, c.id, "idea", "scripted", {}, { stage: "t" });
    await transition(b.db, c.id, "scripted", "voiced", {}, { stage: "t" });
    await transition(b.db, c.id, "voiced", "rendered", { render: { videoPath: video, coverPath: join(dir, "missing.jpg") } }, { stage: "t" });
    const url = (kind: "video" | "cover" = "video", ttl = 60_000) => new URL(signedMediaUrl(b.deps.cfg, c.id, 0, kind, ttl)!);
    return { ...b, id: c.id, url };
  }

  it("serves a validly signed video (with Range support) and nothing else", async () => {
    const { base, url, id } = await withVideo();
    const u = url();
    const ok = await fetch(base + u.pathname + u.search);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("video/mp4");
    expect(await ok.text()).toBe("0123456789");
    const range = await fetch(base + u.pathname + u.search, { headers: { range: "bytes=2-4" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("234");
    // tampered signature, expired link, wrong kind, unknown file name -> all refused
    expect((await fetch(`${base}${u.pathname}?exp=${u.searchParams.get("exp")}&sig=${"0".repeat(64)}`)).status).toBe(403);
    const old = url("video", -1000);
    expect((await fetch(base + old.pathname + old.search)).status).toBe(403);
    expect((await fetch(`${base}/media/${id}/0/cover.jpg${u.search}`)).status).toBe(403); // video signature reused for the cover
    expect((await fetch(`${base}/media/${id}/0/passwd${u.search}`)).status).toBe(403);
  });

  it("404s when the file is gone and rejects traversal-looking ids", async () => {
    const { base, url } = await withVideo();
    const cover = url("cover");
    expect((await fetch(base + cover.pathname + cover.search)).status).toBe(404);
    expect((await fetch(`${base}/media/..%2F..%2Fetc/0/video.mp4?exp=1&sig=00`)).status).toBe(403);
  });
});

describe("OAuth", () => {
  it("returns a consent URL through the authenticated API (the admin token never appears in a URL)", async () => {
    const { get } = await boot();
    const j = await (await get("/api/oauth/tiktok/url")).json();
    expect(j.url).toContain("tiktok.com/v2/auth/authorize");
    expect(j.url).not.toContain(TOKEN);
    expect((await get("/api/oauth/nope/url")).status).toBe(404);
  });

  it("rejects a forged/expired state and accepts a valid one, storing the tokens encrypted", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT-secret", refresh_token: "RT-secret", expires_in: 86400, refresh_expires_in: 31536000, open_id: "u1", scope: "video.publish" })));
    const { base, deps, db, tokens } = await boot();
    deps.fetchImpl = f as any;
    expect((await fetch(`${base}/oauth/tiktok/callback?code=abc&state=forged`)).status).toBe(400);
    expect((await fetch(`${base}/oauth/tiktok/callback?code=abc&state=${makeState(deps.cfg, "youtube")}`)).status).toBe(400); // state for another platform
    const ok = await fetch(`${base}/oauth/tiktok/callback?code=abc&state=${makeState(deps.cfg, "tiktok")}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("tiktok connected");
    expect(JSON.stringify((await db.query(`SELECT access_token_enc, refresh_token_enc FROM oauth_tokens`)).rows)).not.toMatch(/-secret/);
    expect(await tokens.get("tiktok")).toMatchObject({ accessToken: "AT-secret", refreshToken: "RT-secret", accountId: "u1" });
  });

  it("reports a provider failure without leaking markup", async () => {
    const { base, deps } = await boot();
    deps.fetchImpl = (async () => new Response("<script>x</script>", { status: 400 })) as any;
    const r = await fetch(`${base}/oauth/tiktok/callback?code=abc&state=${makeState(deps.cfg, "tiktok")}`);
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("<script>");
  });
});
