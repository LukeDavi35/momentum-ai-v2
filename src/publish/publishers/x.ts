import { readFileSync, statSync } from "node:fs";
import { httpFailure, PublishError, type Metrics, type PublishRequest, type PublishResult, type Publisher } from "../types.js";

type FetchLike = typeof fetch;
const API = "https://api.x.com/2";
const UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";
const CHUNK_BYTES = 4 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * X API v2: chunked media upload (still on the v1.1 upload.twitter.com endpoint - X hasn't moved
 * this to v2) via OAuth2 Bearer auth, then POST /2/tweets. Media upload alone has no public
 * effect (an unattached upload just expires), so assertLive() gates the tweet-creation call, not
 * the upload. Written to the documented API; not yet run against a live app.
 */
export class XPublisher implements Publisher {
  readonly platform = "x" as const;
  readonly live = true;
  constructor(
    private readonly token: () => Promise<string>,
    private readonly f: FetchLike = fetch,
    private readonly pollMs = 3000,
    private readonly maxPolls = 60,
  ) {}

  private async call(url: string, init: RequestInit, what: string): Promise<any> {
    const res = await this.f(url, init);
    const text = await res.text();
    if (!res.ok) throw httpFailure(what, res.status, text);
    return text ? JSON.parse(text) : {};
  }

  private async postForm(params: Record<string, string>, accessToken: string, what: string): Promise<any> {
    return this.call(UPLOAD, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(60_000) }, what);
  }

  private async uploadVideo(videoPath: string, accessToken: string): Promise<string> {
    const size = statSync(videoPath).size;
    const init = await this.postForm({ command: "INIT", total_bytes: String(size), media_type: "video/mp4", media_category: "tweet_video" }, accessToken, "X video init");
    const mediaId: string = init.media_id_string;
    if (!mediaId) throw new PublishError("X video init returned no media_id_string", { retryable: true });

    const bytes = readFileSync(videoPath);
    for (let i = 0, offset = 0; offset < bytes.length; i++, offset += CHUNK_BYTES) {
      const form = new FormData();
      form.append("command", "APPEND");
      form.append("media_id", mediaId);
      form.append("segment_index", String(i));
      form.append("media", new Blob([bytes.subarray(offset, offset + CHUNK_BYTES)]));
      const res = await this.f(UPLOAD, { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw httpFailure("X video append", res.status, await res.text());
    }

    const fin = await this.postForm({ command: "FINALIZE", media_id: mediaId }, accessToken, "X video finalize");
    let info = fin.processing_info;
    for (let i = 0; i < this.maxPolls && info; i++) {
      if (info.state === "succeeded") break;
      if (info.state === "failed") throw new PublishError(`X video processing failed: ${JSON.stringify(info.error ?? {}).slice(0, 200)}`, { retryable: false });
      await sleep(Math.max(this.pollMs, (info.check_after_secs ?? 3) * 1000));
      const status = await this.call(`${UPLOAD}?${new URLSearchParams({ command: "STATUS", media_id: mediaId })}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) }, "X video status");
      info = status.processing_info;
    }
    return mediaId;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const accessToken = await this.token();
    const mediaId = await this.uploadVideo(req.videoPath, accessToken); // no public effect yet - safe to retry on failure

    await req.assertLive(); // last gate before the irreversible tweet
    let tweetId: string;
    try {
      const tweet = await this.call(`${API}/tweets`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ text: req.meta.caption.slice(0, 280), media: { media_ids: [mediaId] } }), signal: AbortSignal.timeout(30_000) }, "X create tweet");
      tweetId = tweet.data?.id;
      if (!tweetId) throw new PublishError("X returned no tweet id", { retryable: true });
    } catch (e) {
      if (e instanceof PublishError && e.opts.status !== undefined && e.opts.status < 500 && e.opts.status !== 429) throw e;
      throw new PublishError(`X tweet create outcome unknown: ${(e as Error).message}`, { retryable: false, ambiguous: true });
    }

    const me = await this.call(`${API}/users/me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }, "X profile").catch(() => null);
    const handle = me?.data?.username;
    return { externalId: tweetId, url: handle ? `https://x.com/${handle}/status/${tweetId}` : undefined };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const accessToken = await this.token();
    const j = await this.call(`${API}/tweets/${externalId}?${new URLSearchParams({ "tweet.fields": "public_metrics" })}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) }, "X metrics");
    const m = j.data?.public_metrics ?? {};
    return {
      views: m.impression_count,
      likes: m.like_count,
      comments: m.reply_count,
      shares: m.retweet_count !== undefined || m.quote_count !== undefined ? (m.retweet_count ?? 0) + (m.quote_count ?? 0) : undefined,
      raw: j,
    };
  }
}
