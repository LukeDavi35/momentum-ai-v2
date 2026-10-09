import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createContent, getContent, transition } from "../src/db/content.js";
import { defaultWeights } from "../src/ideate/weights.js";
import { runPublish } from "../src/publish/agent.js";
import { buildPublishers } from "../src/publish/factory.js";
import { signedMediaUrl, verifyMediaSignature } from "../src/publish/mediaHost.js";
import { authUrl, exchangeCode, makeRefresher, makeState, verifyState } from "../src/publish/oauth.js";
import { DryRunPublisher } from "../src/publish/publishers/dryrun.js";
import { localParts, pickSlot, zonedToUtc } from "../src/publish/schedule.js";
import { decrypt, encrypt, TokenStore } from "../src/publish/tokens.js";
import { PublishError, type Publisher } from "../src/publish/types.js";
import { KillSwitchActive, setKillSwitch } from "../src/safety/killswitch.js";
import { makeDeps, testConfig } from "./helpers.js";

const CID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-10-09T08:00:00Z");

describe("timezones + slot planning", () => {
  it("converts London wall-clock to UTC across the autumn DST change", () => {
    expect(zonedToUtc("2026-10-24", "19:00", "Europe/London").toISOString()).toBe("2026-10-24T18:00:00.000Z"); // BST
    expect(zonedToUtc("2026-10-26", "19:00", "Europe/London").toISOString()).toBe("2026-10-26T19:00:00.000Z"); // GMT
    expect(localParts(new Date("2026-10-09T23:30:00Z"), "Europe/London")).toMatchObject({ ymd: "2026-10-10", hour: 0, minute: 30 });
  });

  const cfg = testConfig();
  const base = { cfg, platform: "tiktok" as const, now: NOW, taken: [] as Date[], hourWeights: defaultWeights().hours, rng: () => 0.5, explore: 0 };

  it("picks a configured peak time within the horizon, in the future", () => {
    const s = pickSlot(base)!;
    expect(s.getTime()).toBeGreaterThan(NOW.getTime());
    expect(s.getTime() - NOW.getTime()).toBeLessThanOrEqual(48 * 3600_000);
    const local = localParts(s, "Europe/London");
    expect([7, 12, 19]).toContain(local.hour);
  });

  it("jitters within the configured window around the peak", () => {
    const rngs = [0, 1].map((r) => pickSlot({ ...base, rng: () => r })!);
    const peak = zonedToUtc("2026-10-09", "12:30", "Europe/London").getTime();
    for (const s of rngs) expect(Math.abs(s.getTime() - peak)).toBeLessThanOrEqual(20 * 60_000 + 1);
  });

  it("follows learned hour weights", () => {
    const hours = { ...defaultWeights().hours, "19": 3, "12": 0.5, "07": 0.5 };
    const s = pickSlot({ ...base, hourWeights: hours, rng: () => 0.5 })!;
    expect(localParts(s, "Europe/London").hour).toBe(19);
  });

  it("keeps a minimum gap from already-taken times and enforces the per-day cap", () => {
    const first = pickSlot({ ...base, rng: () => 0.5 })!;
    const second = pickSlot({ ...base, taken: [first], rng: () => 0.5 })!;
    expect(Math.abs(second.getTime() - first.getTime())).toBeGreaterThanOrEqual(90 * 60_000);
    // fill today's 3 daily slots: the next pick must land on a different local day
    const day = localParts(first, "Europe/London").ymd;
    const filled = ["07:30", "12:30", "19:00"].map((t) => zonedToUtc(day, t, "Europe/London"));
    const next = pickSlot({ ...base, now: new Date(`${day}T05:00:00Z`), taken: filled, rng: () => 0.5 })!;
    expect(localParts(next, "Europe/London").ymd).not.toBe(day);
  });

  it("explores a non-peak hour when the exploration draw hits, and returns null when nothing is free", () => {
    let calls = 0;
    const rng = () => (calls++ === 0 ? 0 : 0.5); // first draw < explore -> explore
    const s = pickSlot({ ...base, explore: 0.5, rng })!;
    expect([7, 12, 19]).not.toContain(localParts(s, "Europe/London").hour);
    const crowded = Array.from({ length: 48 }, (_, i) => new Date(NOW.getTime() + i * 3600_000));
    expect(pickSlot({ ...base, taken: crowded })).toBeNull();
  });
});

describe("token crypto + store", () => {
  const KEY = "ab".repeat(32);
  it("round-trips, uses a fresh IV each time, and rejects tampering or the wrong key", () => {
    const a = encrypt("secret-token", KEY);
    expect(a).not.toContain("secret-token");
    expect(encrypt("secret-token", KEY)).not.toBe(a);
    expect(decrypt(a, KEY)).toBe("secret-token");
    const tampered = `${a.slice(0, -4)}AAAA`;
    expect(() => decrypt(tampered, KEY)).toThrow();
    expect(() => decrypt(a, "cd".repeat(32))).toThrow();
    expect(() => encrypt("x", "short")).toThrow(/64 hex/);
  });

  async function store(refresher = vi.fn(async () => ({ accessToken: "NEW", expiresAt: new Date(NOW.getTime() + 3600_000) })), now = NOW) {
    const { deps, db } = await makeDeps({ now });
    const ts = new TokenStore(db, KEY, deps.log, deps.alerter, refresher as any, () => now);
    return { ts, db, refresher, deps };
  }

  it("stores tokens encrypted at rest", async () => {
    const { ts, db } = await store();
    await ts.save("youtube", { accessToken: "plain-access", refreshToken: "plain-refresh", expiresAt: new Date(NOW.getTime() + 3600_000) });
    const raw = (await db.query(`SELECT access_token_enc, refresh_token_enc FROM oauth_tokens`)).rows[0];
    expect(JSON.stringify(raw)).not.toMatch(/plain-(access|refresh)/);
    expect(await ts.get("youtube")).toMatchObject({ accessToken: "plain-access", refreshToken: "plain-refresh" });
  });

  it("returns a still-valid token untouched, and refreshes one that is about to expire", async () => {
    const { ts, refresher } = await store();
    await ts.save("tiktok", { accessToken: "A", refreshToken: "R", expiresAt: new Date(NOW.getTime() + 3 * 3600_000) });
    expect((await ts.getValidAccessToken("tiktok")).accessToken).toBe("A");
    expect(refresher).not.toHaveBeenCalled();
    await ts.save("tiktok", { accessToken: "A", refreshToken: "R", expiresAt: new Date(NOW.getTime() + 60_000) });
    const t = await ts.getValidAccessToken("tiktok");
    expect(t.accessToken).toBe("NEW");
    expect(t.refreshToken).toBe("R"); // preserved when the provider doesn't rotate it
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("alerts (critical) and records the error when a refresh fails", async () => {
    const { ts, db } = await store(vi.fn(async () => {
      throw new Error("invalid_grant");
    }) as any);
    await ts.save("youtube", { accessToken: "A", refreshToken: "R", expiresAt: new Date(NOW.getTime() + 1000) });
    await expect(ts.getValidAccessToken("youtube")).rejects.toThrow("invalid_grant");
    expect((await db.query(`SELECT last_refresh_error FROM oauth_tokens`)).rows[0].last_refresh_error).toContain("invalid_grant");
    expect((await db.query(`SELECT severity FROM alerts_log WHERE key = 'token_refresh_failed:youtube'`)).rows[0].severity).toBe("critical");
  });

  it("errors clearly when no account is connected or the key is missing", async () => {
    const { ts, deps, db } = await store();
    await expect(ts.getValidAccessToken("instagram")).rejects.toThrow(/No instagram account connected/);
    const keyless = new TokenStore(db, undefined, deps.log, deps.alerter, vi.fn() as any);
    await expect(keyless.save("youtube", { accessToken: "x" })).rejects.toThrow(/TOKEN_ENC_KEY/);
  });

  it("the scheduled sweep refreshes expiring tokens, reports missing ones, and warns before a refresh token lapses", async () => {
    const { ts, db } = await store();
    await ts.save("tiktok", { accessToken: "A", refreshToken: "R", expiresAt: new Date(NOW.getTime() + 2 * 3600_000), refreshExpiresAt: new Date(NOW.getTime() + 3 * 86400_000) });
    await ts.save("youtube", { accessToken: "B", refreshToken: "R", expiresAt: new Date(NOW.getTime() + 10 * 3600_000 * 24) });
    const out = await ts.refreshExpiring(["tiktok", "instagram", "youtube"]);
    expect(out).toEqual([{ platform: "tiktok", action: "refreshed" }, { platform: "instagram", action: "missing" }, { platform: "youtube", action: "ok" }]);
    expect((await db.query(`SELECT 1 FROM alerts_log WHERE key = 'refresh_token_expiring:tiktok'`)).rowCount).toBe(1);
  });
});

describe("oauth + signed media", () => {
  const cfg = testConfig({ PUBLIC_BASE_URL: "https://app.test", TOKEN_ENC_KEY: "ab".repeat(32), TIKTOK_CLIENT_KEY: "tk", INSTAGRAM_APP_ID: "ig", GOOGLE_CLIENT_ID: "g", MEDIA_SIGNING_SECRET: "sekrit" });

  it("signs state per platform, rejects forgery / wrong platform / expiry", () => {
    const s = makeState(cfg, "youtube", 1000);
    expect(verifyState(cfg, s, "youtube", 2000)).toBe(true);
    expect(verifyState(cfg, s, "tiktok", 2000)).toBe(false);
    expect(verifyState(cfg, `${s.slice(0, -2)}00`, "youtube", 2000)).toBe(false);
    expect(verifyState(cfg, s, "youtube", 1000 + 16 * 60_000)).toBe(false);
  });

  it("builds auth URLs with the right client id, redirect, scopes (and offline access for Google)", () => {
    const u = new URL(authUrl(cfg, "youtube", "st"));
    expect(u.hostname).toBe("accounts.google.com");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/oauth/youtube/callback");
    expect(new URL(authUrl(cfg, "tiktok", "st")).searchParams.get("scope")).toContain("video.publish");
    expect(new URL(authUrl(cfg, "instagram", "st")).searchParams.get("scope")).toContain("instagram_business_content_publish");
    expect(() => authUrl(testConfig(), "youtube", "x")).toThrow(/PUBLIC_BASE_URL/);
  });

  it("exchanges a Google code and insists on a refresh token", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: 200 }));
    const t = await exchangeCode(cfg, "youtube", "code", f as any, NOW);
    expect(t).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(t.expiresAt!.getTime()).toBe(NOW.getTime() + 3600_000);
    const noRefresh = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 })));
    await expect(exchangeCode(cfg, "youtube", "code", noRefresh as any, NOW)).rejects.toThrow(/refresh_token/);
  });

  it("refreshes each platform through its own endpoint", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (url: any) => {
      seen.push(String(url).split("?")[0]!);
      return new Response(JSON.stringify({ access_token: "N", refresh_token: "R2", expires_in: 100 }), { status: 200 });
    });
    const r = makeRefresher(cfg, f as any, () => NOW);
    await r("tiktok", { accessToken: "a", refreshToken: "r" });
    await r("instagram", { accessToken: "a" });
    await r("youtube", { accessToken: "a", refreshToken: "r" });
    expect(seen).toEqual(["https://open.tiktokapis.com/v2/oauth/token/", "https://graph.instagram.com/refresh_access_token", "https://oauth2.googleapis.com/token"]);
    await expect(r("youtube", { accessToken: "a" })).rejects.toThrow(/refresh token/);
  });

  it("signed media URLs verify, expire, and cannot be reused for another file", () => {
    const url = new URL(signedMediaUrl(cfg, "c1", 0, "video", 60_000, 1_000_000)!);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig")!;
    expect(url.pathname).toBe("/media/c1/0/video.mp4");
    expect(verifyMediaSignature(cfg, "c1", 0, "video", exp, sig, 1_000_001)).toBe(true);
    expect(verifyMediaSignature(cfg, "c1", 0, "video", exp, sig, exp + 1)).toBe(false);
    expect(verifyMediaSignature(cfg, "c2", 0, "video", exp, sig, 1_000_001)).toBe(false);
    expect(verifyMediaSignature(cfg, "c1", 0, "cover", exp, sig, 1_000_001)).toBe(false);
    expect(signedMediaUrl(testConfig(), "c1", 0, "video")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ publish agent

class SpyPublisher implements Publisher {
  readonly live = true;
  publish = vi.fn(async (req: any) => {
    await req.assertLive();
    return { externalId: `ext-${this.platform}`, url: `https://x/${this.platform}` };
  });
  metrics = vi.fn(async () => ({}));
  constructor(readonly platform: "tiktok" | "instagram" | "youtube") {}
}

async function qaPassedContent(env: Record<string, string> = {}) {
  const ctx = await makeDeps({ now: NOW, env });
  const { deps, db } = ctx;
  const dir = mkdtempSync(join(tmpdir(), "p-"));
  const video = join(dir, "video.mp4");
  writeFileSync(video, "x");
  const c = await createContent(db, { pillar: "running", template: "quick_explainer", topic: "Warm-ups explained", idea: {}, sourceItemIds: [], correlationId: CID });
  const script = {
    title: "t", hookStyle: "question", beats: [{ id: "b1", text: "Why warm up?", onScreen: "", claimIds: [] }], claims: [], visual: { headline: "H", items: [] },
    variants: { tiktok: { caption: "Why warm up?", hashtags: ["running"] }, instagram: { caption: "Why warm up?", hashtags: ["running"] }, youtube: { title: "Why warm up?", description: "Explained", hashtags: ["running"] } },
    sourceAliases: {}, estimatedDurationS: 20, removed: [], generator: "live",
  };
  await transition(db, c.id, "idea", "scripted", { script }, { stage: "t" });
  await transition(db, c.id, "scripted", "voiced", {}, { stage: "t" });
  await transition(db, c.id, "voiced", "rendered", { render: { videoPath: video, coverPath: video, durationS: 20 } }, { stage: "t" });
  await transition(db, c.id, "rendered", "qa_passed", {}, { stage: "t" });
  const spies = { tiktok: new SpyPublisher("tiktok"), instagram: new SpyPublisher("instagram"), youtube: new SpyPublisher("youtube") };
  deps.publishers = spies;
  deps.rng = () => 0.5;
  return { ...ctx, id: c.id, spies };
}

async function schedule(ctx: Awaited<ReturnType<typeof qaPassedContent>>) {
  await runPublish(ctx.deps, { kind: "schedule", contentId: ctx.id, correlationId: CID });
  return (await ctx.db.query(`SELECT * FROM publications ORDER BY platform`)).rows;
}

describe("publish: scheduling", () => {
  it("creates one publication per enabled platform with metadata, delayed publish jobs, and moves content to scheduled", async () => {
    const ctx = await qaPassedContent();
    const pubs = await schedule(ctx);
    expect(pubs.map((p) => p.platform)).toEqual(["instagram", "tiktok", "youtube"]);
    expect(pubs.every((p) => p.status === "scheduled" && p.dry_run === true)).toBe(true);
    expect(pubs[0].metadata.meta.caption).toContain("AI-assisted video");
    expect((await getContent(ctx.db, ctx.id))!.status).toBe("scheduled");
    const jobs = ctx.enqueued.filter((e) => e.queue === "publish");
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.data.kind === "publish" && (j.opts?.delayMs ?? 0) > 0)).toBe(true);
  });

  it("skips disabled platforms and is idempotent on redelivery", async () => {
    const ctx = await qaPassedContent();
    ctx.deps.cfg.schedule.platforms.instagram.enabled = false;
    await schedule(ctx);
    expect(await runPublish(ctx.deps, { kind: "schedule", contentId: ctx.id, correlationId: CID })).toBe("skipped");
    expect((await ctx.db.query(`SELECT platform FROM publications ORDER BY platform`)).rows.map((r) => r.platform)).toEqual(["tiktok", "youtube"]);
    ctx.deps.cfg.schedule.platforms.instagram.enabled = true;
  });

  it("fast dry-run mode schedules ~immediately", async () => {
    const ctx = await qaPassedContent({ DRY_RUN_FAST: "true" });
    await schedule(ctx);
    const delays = ctx.enqueued.filter((e) => e.queue === "publish").map((e) => e.opts!.delayMs!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
  });
});

describe("publish: posting", () => {
  const dueNow = async (ctx: Awaited<ReturnType<typeof qaPassedContent>>) => {
    await schedule(ctx);
    await ctx.db.query(`UPDATE publications SET scheduled_at = $1`, [NOW.toISOString()]);
    return (await ctx.db.query(`SELECT id, platform FROM publications ORDER BY platform`)).rows as Array<{ id: string; platform: "tiktok" | "instagram" | "youtube" }>;
  };
  const post = (ctx: Awaited<ReturnType<typeof qaPassedContent>>, id: string) => runPublish(ctx.deps, { kind: "publish", contentId: ctx.id, publicationId: id, correlationId: CID });

  it("publishes, records the external id/url, marks content published, and queues the 1h/24h/7d analytics pulls", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    expect(await post(ctx, ig!.id)).toBe("published");
    const row = (await ctx.db.query(`SELECT * FROM publications WHERE id = $1`, [ig!.id])).rows[0];
    expect(row).toMatchObject({ status: "published", external_id: "ext-instagram", url: "https://x/instagram", attempts: 1 });
    expect((await getContent(ctx.db, ctx.id))!.status).toBe("published");
    const analytics = ctx.enqueued.filter((e) => e.queue === "analytics");
    expect(analytics.map((a) => a.data.checkpoint)).toEqual(["1h", "24h", "7d"]);
    expect(analytics.map((a) => a.opts!.delayMs)).toEqual([3600_000, 86400_000, 7 * 86400_000]);
  });

  it("KILL SWITCH BLOCKS PUBLISHING: nothing is posted, the publication stays scheduled, and releasing it allows the post", async () => {
    const ctx = await qaPassedContent();
    const pubs = await dueNow(ctx);
    await setKillSwitch(ctx.db, undefined, true, "test", "drill");
    for (const p of pubs) {
      await expect(post(ctx, p.id)).rejects.toBeInstanceOf(KillSwitchActive);
    }
    expect(Object.values(ctx.spies).every((s) => s.publish.mock.calls.length === 0)).toBe(true);
    expect((await ctx.db.query(`SELECT DISTINCT status FROM publications`)).rows).toEqual([{ status: "scheduled" }]);
    expect((await getContent(ctx.db, ctx.id))!.status).toBe("scheduled");
    await setKillSwitch(ctx.db, undefined, false, "test");
    expect(await post(ctx, pubs[0]!.id)).toBe("published");
    expect(ctx.spies.instagram.publish).toHaveBeenCalledTimes(1);
  });

  it("KILL SWITCH ALSO WINS THE RACE: if it is engaged after the claim but before the platform call, nothing is posted and the claim is released", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    ctx.spies.instagram.publish.mockImplementationOnce(async (req: any) => {
      await setKillSwitch(ctx.db, undefined, true, "race"); // flipped mid-flight
      await req.assertLive(); // the publisher's last gate before the irreversible call
      return { externalId: "SHOULD-NOT-HAPPEN", url: "" };
    });
    await expect(post(ctx, ig!.id)).rejects.toBeInstanceOf(KillSwitchActive);
    const row = (await ctx.db.query(`SELECT status, external_id FROM publications WHERE id = $1`, [ig!.id])).rows[0];
    expect(row).toEqual({ status: "scheduled", external_id: null });
  });

  it("the KILL_SWITCH env var blocks too", async () => {
    const ctx = await qaPassedContent({ KILL_SWITCH: "true" });
    const [ig] = await dueNow(ctx);
    await expect(post(ctx, ig!.id)).rejects.toBeInstanceOf(KillSwitchActive);
    expect(ctx.spies.instagram.publish).not.toHaveBeenCalled();
  });

  it("is idempotent: a duplicate delivery of an already-published publication does nothing", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    await post(ctx, ig!.id);
    expect(await post(ctx, ig!.id)).toBe("skipped");
    expect(ctx.spies.instagram.publish).toHaveBeenCalledTimes(1);
  });

  it("only one of two concurrent deliveries can claim and post (no double post)", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    const results = await Promise.all([post(ctx, ig!.id), post(ctx, ig!.id)]);
    expect(results.filter((r) => r === "published")).toHaveLength(1);
    expect(ctx.spies.instagram.publish).toHaveBeenCalledTimes(1);
  });

  it("hits the hard daily cap by moving the post to a later slot instead of posting or failing", async () => {
    const ctx = await qaPassedContent({ MAX_POSTS_PER_DAY: "1" });
    const pubs = await dueNow(ctx);
    expect(await post(ctx, pubs[0]!.id)).toBe("published");
    expect(await post(ctx, pubs[1]!.id)).toBe("rescheduled");
    expect(ctx.spies.tiktok.publish).not.toHaveBeenCalled();
    const row = (await ctx.db.query(`SELECT status, scheduled_at FROM publications WHERE id = $1`, [pubs[1]!.id])).rows[0];
    expect(row.status).toBe("scheduled");
    expect(new Date(row.scheduled_at).getTime()).toBeGreaterThan(NOW.getTime());
    expect(ctx.enqueued.at(-1)).toMatchObject({ queue: "publish", data: { regen: 1 } });
  });

  it("a retryable platform error restores the claim and rethrows so BullMQ backs off and retries", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    ctx.spies.instagram.publish.mockRejectedValueOnce(new PublishError("HTTP 503", { retryable: true }));
    await expect(post(ctx, ig!.id)).rejects.toThrow("HTTP 503");
    expect((await ctx.db.query(`SELECT status FROM publications WHERE id = $1`, [ig!.id])).rows[0].status).toBe("scheduled");
    expect(await post(ctx, ig!.id)).toBe("published"); // the retry succeeds
  });

  it("an AMBIGUOUS outcome is parked as failed with a critical alert and is never retried", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    ctx.spies.instagram.publish.mockRejectedValueOnce(new PublishError("timeout after media_publish", { retryable: false, ambiguous: true }));
    expect(await post(ctx, ig!.id)).toBe("failed");
    expect((await ctx.db.query(`SELECT status FROM publications WHERE id = $1`, [ig!.id])).rows[0].status).toBe("failed");
    const alert = (await ctx.db.query(`SELECT severity, title FROM alerts_log WHERE key = $1`, [`publish_failed:${ig!.id}`])).rows[0];
    expect(alert.severity).toBe("critical");
    expect(alert.title).toMatch(/OUTCOME UNKNOWN/);
    expect(await post(ctx, ig!.id)).toBe("skipped"); // not re-claimed
  });

  it("fails the content only when every platform has failed permanently", async () => {
    const ctx = await qaPassedContent();
    const pubs = await dueNow(ctx);
    for (const s of Object.values(ctx.spies)) s.publish.mockRejectedValue(new PublishError("policy rejected", { retryable: false }));
    for (const p of pubs.slice(0, 2)) await post(ctx, p.id);
    expect((await getContent(ctx.db, ctx.id))!.status).toBe("scheduled");
    await post(ctx, pubs[2]!.id);
    expect((await getContent(ctx.db, ctx.id))!.status).toBe("failed");
  });

  it("moves a post that missed its window (e.g. a long pause) to a fresh slot rather than posting it stale", async () => {
    const ctx = await qaPassedContent();
    const [ig] = await dueNow(ctx);
    await ctx.db.query(`UPDATE publications SET scheduled_at = $1 WHERE id = $2`, [new Date(NOW.getTime() - 8 * 3600_000).toISOString(), ig!.id]);
    expect(await post(ctx, ig!.id)).toBe("rescheduled");
    expect(ctx.spies.instagram.publish).not.toHaveBeenCalled();
  });
});

describe("dry-run publisher + factory", () => {
  it("DRY_RUN can only ever build dry-run publishers (no path to a real API)", () => {
    const pubs = buildPublishers(testConfig({ DRY_RUN: "true" }), undefined);
    expect(Object.values(pubs).every((p) => !p.live && p instanceof DryRunPublisher)).toBe(true);
    expect(() => buildPublishers(testConfig({ DRY_RUN: "false" }), undefined)).toThrow(/TokenStore/);
  });

  it("writes the exact would-be payload to disk and returns synthetic ids/metrics flagged as synthetic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dry-"));
    const p = new DryRunPublisher("tiktok", dir);
    const assertLive = vi.fn(async () => {});
    const r = await p.publish({ contentId: "c1", videoPath: "/v.mp4", durationS: 30, assertLive, meta: { platform: "tiktok", title: "T", caption: "C", hashtags: ["a"], aiDisclosure: { applied: true, line: "AI", nativeFlag: "is_aigc" }, sourceCredit: null } });
    expect(assertLive).toHaveBeenCalled(); // even dry runs honour the kill switch
    const file = join(dir, "tiktok-c1.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).wouldPost.caption).toBe("C");
    expect(r.externalId).toMatch(/^dryrun_/);
    const m = await p.metrics(r.externalId);
    expect((m.raw as any).synthetic).toBe(true);
    expect(await p.metrics(r.externalId)).toEqual(m); // deterministic
  });
});
