import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InstagramPublisher } from "../src/publish/publishers/instagram.js";
import { TikTokPublisher } from "../src/publish/publishers/tiktok.js";
import { YouTubePublisher } from "../src/publish/publishers/youtube.js";
import { PublishError, type PublishRequest } from "../src/publish/types.js";
import type { PlatformMetadata } from "../src/publish/metadata.js";

const dir = mkdtempSync(join(tmpdir(), "pub-"));
const videoPath = join(dir, "video.mp4");
const coverPath = join(dir, "cover.jpg");
writeFileSync(videoPath, Buffer.alloc(2048, 1));
writeFileSync(coverPath, Buffer.alloc(64, 2));

const meta = (platform: "tiktok" | "instagram" | "youtube"): PlatformMetadata => ({
  platform,
  title: "Kipyegon's record",
  caption: "Record night in Paris\n#athletics\nAI-assisted video with a synthetic voiceover.",
  hashtags: ["athletics"],
  aiDisclosure: { applied: true, line: "AI-assisted video with a synthetic voiceover.", nativeFlag: platform === "tiktok" ? "is_aigc" : platform === "youtube" ? "containsSyntheticMedia" : "none" },
  sourceCredit: "Source: BBC Sport",
});
const req = (platform: "tiktok" | "instagram" | "youtube", assertLive = vi.fn(async () => {})): PublishRequest & { assertLive: ReturnType<typeof vi.fn> } => ({
  contentId: "c1",
  videoPath,
  coverPath,
  mediaUrl: "https://app.test/media/c1/0/video.mp4?exp=1&sig=2",
  coverUrl: "https://app.test/media/c1/0/cover.jpg?exp=1&sig=2",
  durationS: 31,
  meta: meta(platform),
  assertLive,
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; init: RequestInit; body?: any }> = [];
  const f = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    let body: any;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
    calls.push({ url: u, init, body });
    const route = routes.find(([re]) => re.test(u));
    if (!route) throw new Error(`unexpected fetch ${u}`);
    return route[1](u, init);
  });
  return { f: f as unknown as typeof fetch, calls };
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });

describe("TikTokPublisher", () => {
  const happy = (privacy = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], statuses = ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"]) => {
    let polls = 0;
    return mockFetch([
      [/creator_info/, () => json({ data: { privacy_level_options: privacy, max_video_post_duration_sec: 600 }, error: { code: "ok" } })],
      [/video\/init/, () => json({ data: { publish_id: "p123", upload_url: "https://upload.tiktok.test/u" }, error: { code: "ok" } })],
      [/upload\.tiktok\.test/, () => new Response("", { status: 201 })],
      [/status\/fetch/, () => json({ data: { status: statuses[Math.min(polls++, statuses.length - 1)], publicaly_available_post_id: ["7777"] }, error: { code: "ok" } })],
    ]);
  };

  it("runs creator_info -> init -> upload -> status and returns the post id, flagging AI content (is_aigc)", async () => {
    const { f, calls } = happy();
    const r = req("tiktok");
    const out = await new TikTokPublisher(async () => "AT", f, 0).publish(r);
    expect(out).toMatchObject({ externalId: "7777" });
    expect(calls.map((c) => c.url.split("tiktokapis.com")[1] ?? "upload")).toEqual(["/v2/post/publish/creator_info/query/", "/v2/post/publish/video/init/", "upload", "/v2/post/publish/status/fetch/", "/v2/post/publish/status/fetch/"]);
    const init = calls[1]!.body;
    expect(init.post_info).toMatchObject({ is_aigc: true, privacy_level: "PUBLIC_TO_EVERYONE", brand_content_toggle: false, brand_organic_toggle: false, title: r.meta.caption });
    expect(init.source_info).toMatchObject({ source: "FILE_UPLOAD", video_size: 2048, chunk_size: 2048, total_chunk_count: 1 });
    expect((calls[2]!.init.headers as any)["content-range"]).toBe("bytes 0-2047/2048");
    expect((calls[0]!.init.headers as any).authorization).toBe("Bearer AT");
    expect(r.assertLive).toHaveBeenCalledTimes(1);
  });

  it("asserts the final gate BEFORE init (nothing irreversible happens ahead of it)", async () => {
    const { f, calls } = happy();
    const order: string[] = [];
    const r = req("tiktok", vi.fn(async () => void order.push(`gate after ${calls.length} calls`)));
    await new TikTokPublisher(async () => "AT", f, 0).publish(r);
    expect(order).toEqual(["gate after 1 calls"]); // only creator_info had been called
  });

  it("falls back to SELF_ONLY when the app is unaudited and says so", async () => {
    const { f, calls } = happy(["SELF_ONLY"]);
    const out = await new TikTokPublisher(async () => "AT", f, 0).publish(req("tiktok"));
    expect(calls[1]!.body.post_info.privacy_level).toBe("SELF_ONLY");
    expect(out.warnings![0]).toMatch(/SELF_ONLY/);
  });

  it("refuses videos longer than the account allows, before any gate or upload", async () => {
    const { f } = mockFetch([[/creator_info/, () => json({ data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 10 }, error: { code: "ok" } })]]);
    const r = req("tiktok");
    await expect(new TikTokPublisher(async () => "AT", f, 0).publish(r)).rejects.toMatchObject({ retryable: false });
    expect(r.assertLive).not.toHaveBeenCalled();
  });

  it("a FAILED status is permanent, a never-confirmed publish is AMBIGUOUS (not retryable)", async () => {
    const failed = happy(undefined, ["FAILED"]);
    await expect(new TikTokPublisher(async () => "AT", failed.f, 0).publish(req("tiktok"))).rejects.toMatchObject({ retryable: false, ambiguous: false });
    const stuck = happy(undefined, ["PROCESSING_UPLOAD"]);
    await expect(new TikTokPublisher(async () => "AT", stuck.f, 0, 3).publish(req("tiktok"))).rejects.toMatchObject({ retryable: false, ambiguous: true });
  });

  it("rate limiting at init is retryable", async () => {
    const { f } = mockFetch([
      [/creator_info/, () => json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })],
      [/video\/init/, () => json({ error: { code: "rate_limit_exceeded", message: "slow down" } })],
    ]);
    await expect(new TikTokPublisher(async () => "AT", f, 0).publish(req("tiktok"))).rejects.toMatchObject({ retryable: true });
  });

  it("returns real metrics only; unavailable ones stay undefined (never faked)", async () => {
    const { f } = mockFetch([[/video\/query/, () => json({ data: { videos: [{ id: "7777", view_count: 1200, like_count: 90, comment_count: 7, share_count: 12 }] }, error: { code: "ok" } })]]);
    const m = await new TikTokPublisher(async () => "AT", f).metrics("7777");
    expect(m).toMatchObject({ views: 1200, likes: 90, comments: 7, shares: 12 });
    expect(m.retentionPct).toBeUndefined();
    expect(m.saves).toBeUndefined();
  });
});

describe("InstagramPublisher", () => {
  const tok = async () => ({ accessToken: "IGT", accountId: "1784" });
  const happy = (publishStatus = 200, statuses = ["IN_PROGRESS", "FINISHED"]) => {
    let polls = 0;
    return mockFetch([
      [/content_publishing_limit/, () => json({ data: [{ quota_usage: 2, config: { quota_total: 100 } }] })],
      [/\/1784\/media_publish/, () => (publishStatus === 200 ? json({ id: "m999" }) : new Response("upstream timeout", { status: publishStatus }))],
      [/\/1784\/media(\?|$)/, () => json({ id: "container1" })],
      [/\/container1\?/, () => json({ status_code: statuses[Math.min(polls++, statuses.length - 1)] })],
      [/\/m999\?/, () => json({ permalink: "https://instagram.com/reel/abc" })],
    ]);
  };

  it("creates a REELS container with the public URL, waits for FINISHED, then publishes", async () => {
    const { f, calls } = happy();
    const r = req("instagram");
    const out = await new InstagramPublisher(tok, f, 0).publish(r);
    expect(out).toEqual({ externalId: "m999", url: "https://instagram.com/reel/abc" });
    const create = calls.find((c) => /\/1784\/media$/.test(c.url.split("?")[0]!))!;
    expect(create.body).toMatchObject({ media_type: "REELS", video_url: r.mediaUrl, cover_url: r.coverUrl, share_to_feed: "true", caption: r.meta.caption, access_token: "IGT" });
    const order = calls.map((c) => c.url.split("?")[0]!.split("/").slice(-1)[0]);
    expect(order.indexOf("media_publish")).toBeGreaterThan(order.lastIndexOf("container1"));
    expect(r.assertLive).toHaveBeenCalledTimes(1);
  });

  it("gates right before media_publish, after the container is ready", async () => {
    const { f, calls } = happy();
    let callsAtGate = -1;
    const r = req("instagram", vi.fn(async () => void (callsAtGate = calls.length)));
    await new InstagramPublisher(tok, f, 0).publish(r);
    expect(calls[callsAtGate - 1]!.url).toMatch(/container1/); // the last call before the gate was the FINISHED poll
    expect(calls[callsAtGate]!.url).toMatch(/media_publish/);
  });

  it("needs a public URL and respects the 90s Reels limit", async () => {
    const { f } = happy();
    await expect(new InstagramPublisher(tok, f, 0).publish({ ...req("instagram"), mediaUrl: undefined })).rejects.toMatchObject({ retryable: false });
    await expect(new InstagramPublisher(tok, f, 0).publish({ ...req("instagram"), durationS: 120 })).rejects.toMatchObject({ retryable: false });
  });

  it("a container ERROR fails without publishing", async () => {
    const { f, calls } = happy(200, ["ERROR"]);
    await expect(new InstagramPublisher(tok, f, 0).publish(req("instagram"))).rejects.toBeInstanceOf(PublishError);
    expect(calls.some((c) => /media_publish/.test(c.url))).toBe(false);
  });

  it("a 5xx from media_publish is AMBIGUOUS and must not be auto-retried", async () => {
    const { f } = happy(502);
    await expect(new InstagramPublisher(tok, f, 0).publish(req("instagram"))).rejects.toMatchObject({ retryable: false, ambiguous: true });
  });

  it("stops when Instagram's own 24h publishing quota is used up (retryable later)", async () => {
    const { f, calls } = mockFetch([[/content_publishing_limit/, () => json({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] })]]);
    await expect(new InstagramPublisher(tok, f, 0).publish(req("instagram"))).rejects.toMatchObject({ retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("insights: drops an unsupported metric and retries, converts ms watch time to seconds", async () => {
    let n = 0;
    const { f, calls } = mockFetch([
      [
        /\/m999\/insights/,
        (url) => {
          n++;
          if (url.includes("ig_reels_video_view_total_time")) return new Response(JSON.stringify({ error: { message: "metric ig_reels_video_view_total_time is not supported for this media" } }), { status: 400 });
          return json({ data: [{ name: "views", values: [{ value: 5000 }] }, { name: "saved", values: [{ value: 40 }] }, { name: "ig_reels_avg_watch_time", values: [{ value: 9500 }] }, { name: "shares", values: [{ value: 12 }] }] });
        },
      ],
    ]);
    const m = await new InstagramPublisher(tok, f).metrics("m999");
    expect(n).toBe(2);
    expect(calls[1]!.url).not.toContain("ig_reels_video_view_total_time");
    expect(m).toMatchObject({ views: 5000, saves: 40, shares: 12, avgViewDurationS: 9.5 });
  });
});

describe("YouTubePublisher", () => {
  const happy = (putStatus = 200) =>
    mockFetch([
      [/uploadType=resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.yt.test/session1" } })],
      [/upload\.yt\.test/, () => (putStatus === 200 ? json({ id: "vid123", status: { privacyStatus: "public" } }) : new Response("boom", { status: putStatus }))],
      [/thumbnails\/set/, () => json({}, 200)],
    ]);

  it("starts a resumable upload declaring synthetic media, uploads the bytes, sets the thumbnail, returns the Shorts URL", async () => {
    const { f, calls } = happy();
    const r = req("youtube");
    const out = await new YouTubePublisher(async () => "YT", f).publish(r);
    expect(out).toMatchObject({ externalId: "vid123", url: "https://www.youtube.com/shorts/vid123" });
    const start = calls[0]!.body;
    expect(start.status).toMatchObject({ privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
    expect(start.snippet).toMatchObject({ title: r.meta.title, categoryId: "17" });
    expect(start.snippet.description).toContain("#Shorts");
    expect((calls[0]!.init.headers as any)["x-upload-content-length"]).toBe("2048");
    expect(calls.map((c) => c.url.split("?")[0]!.split("/").slice(-1)[0])).toEqual(["videos", "session1", "set"]);
    expect(r.assertLive).toHaveBeenCalledTimes(1);
  });

  it("warns (not fails) when YouTube forces the upload private, or the thumbnail is rejected", async () => {
    const { f } = mockFetch([
      [/uploadType=resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.yt.test/s" } })],
      [/upload\.yt\.test/, () => json({ id: "v1", status: { privacyStatus: "private" } })],
      [/thumbnails\/set/, () => json({}, 403)],
    ]);
    const out = await new YouTubePublisher(async () => "YT", f).publish(req("youtube"));
    expect(out.warnings!.join(" ")).toMatch(/privacyStatus=private/);
    expect(out.warnings!.join(" ")).toMatch(/thumbnail not set/);
  });

  it("a rate-limited start is retryable; a 5xx after the bytes were sent is AMBIGUOUS", async () => {
    const limited = mockFetch([[/uploadType=resumable/, () => new Response("quota", { status: 429 })]]);
    await expect(new YouTubePublisher(async () => "YT", limited.f).publish(req("youtube"))).rejects.toMatchObject({ retryable: true });
    await expect(new YouTubePublisher(async () => "YT", happy(503).f).publish(req("youtube"))).rejects.toMatchObject({ retryable: false, ambiguous: true });
  });

  it("a network drop mid-upload is AMBIGUOUS", async () => {
    const { f } = mockFetch([
      [/uploadType=resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.yt.test/s" } })],
      [/upload\.yt\.test/, () => {
        throw new Error("socket hang up");
      }],
    ]);
    await expect(new YouTubePublisher(async () => "YT", f).publish(req("youtube"))).rejects.toMatchObject({ retryable: false, ambiguous: true });
  });

  it("metrics combine Data API statistics with Analytics API retention when available", async () => {
    const { f } = mockFetch([
      [/youtube\/v3\/videos\?part=statistics/, () => json({ items: [{ statistics: { viewCount: "900", likeCount: "70", commentCount: "5" } }] })],
      [/youtubeanalytics/, () => json({ rows: [[900, 12, 14.5, 62.3, 8, 3]] })],
    ]);
    const m = await new YouTubePublisher(async () => "YT", f, () => new Date("2026-10-10")).metrics("vid123", { publishedAt: new Date("2026-10-09") });
    expect(m).toMatchObject({ views: 900, likes: 70, comments: 5, watchTimeS: 720, avgViewDurationS: 14.5, retentionPct: 62.3, shares: 8, follows: 3 });
  });

  it("metrics still return basic stats if the Analytics API isn't available yet", async () => {
    const { f } = mockFetch([
      [/youtube\/v3\/videos\?part=statistics/, () => json({ items: [{ statistics: { viewCount: "10" } }] })],
      [/youtubeanalytics/, () => new Response("forbidden", { status: 403 })],
    ]);
    const m = await new YouTubePublisher(async () => "YT", f).metrics("v");
    expect(m.views).toBe(10);
    expect(m.retentionPct).toBeUndefined();
  });
});
