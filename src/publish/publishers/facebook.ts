import { httpFailure, PublishError, type Metrics, type PublishRequest, type PublishResult, type Publisher } from "../types.js";

type FetchLike = typeof fetch;
const GRAPH = "https://graph.facebook.com/v23.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Facebook Page video posts via the Graph API: POST /{page-id}/videos with a public file_url does
 * the create-and-publish in one call (unlike Instagram's separate container/media_publish steps),
 * so that POST is the one irreversible action here. Written to the documented API; not yet run
 * against a live Page.
 */
export class FacebookPublisher implements Publisher {
  readonly platform = "facebook" as const;
  readonly live = true;
  constructor(
    private readonly token: () => Promise<{ accessToken: string; pageId: string }>,
    private readonly f: FetchLike = fetch,
    private readonly pollMs = 5000,
    private readonly maxPolls = 60,
  ) {}

  private async getJson(url: string, what: string): Promise<any> {
    const res = await this.f(url, { signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw httpFailure(what, res.status, text);
    return JSON.parse(text);
  }

  private async postForm(url: string, params: Record<string, string>, what: string): Promise<any> {
    const res = await this.f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw httpFailure(what, res.status, text);
    return JSON.parse(text);
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    if (!req.mediaUrl) throw new PublishError("Facebook needs a public mediaUrl (set PUBLIC_BASE_URL)", { retryable: false });
    const { accessToken, pageId } = await this.token();

    await req.assertLive(); // last gate before the irreversible publish
    let videoId: string;
    try {
      const created = await this.postForm(
        `${GRAPH}/${pageId}/videos`,
        { file_url: req.mediaUrl, description: req.meta.caption, access_token: accessToken },
        "Facebook create video",
      );
      videoId = created.id;
      if (!videoId) throw new PublishError("Facebook returned no video id", { retryable: true });
    } catch (e) {
      // a timeout/5xx here may still have posted: never auto-retry
      if (e instanceof PublishError && e.opts.status !== undefined && e.opts.status < 500 && e.opts.status !== 429) throw e;
      throw new PublishError(`Facebook video create outcome unknown: ${(e as Error).message}`, { retryable: false, ambiguous: true });
    }

    // The post already exists on Facebook's side from here - this only confirms processing finished.
    for (let i = 0; ; i++) {
      if (i >= this.maxPolls) break; // posted but still processing; metrics/permalink can catch up later
      const s = await this.getJson(`${GRAPH}/${videoId}?${new URLSearchParams({ fields: "status,permalink_url", access_token: accessToken })}`, "Facebook video status");
      const stage: string | undefined = s.status?.video_status;
      if (stage === "ready") return { externalId: String(videoId), url: s.permalink_url ? `https://www.facebook.com${s.permalink_url}` : undefined };
      if (stage === "error") throw new PublishError(`Facebook video processing error: ${JSON.stringify(s.status).slice(0, 200)}`, { retryable: false, ambiguous: true });
      await sleep(this.pollMs);
    }
    return { externalId: String(videoId), warnings: ["still processing on Facebook's side when polling gave up; it should finish on its own"] };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const { accessToken } = await this.token();
    const fields = "likes.summary(true),comments.summary(true),shares,video_insights.metric(total_video_views,total_video_avg_time_watched)";
    const j = await this.getJson(`${GRAPH}/${externalId}?${new URLSearchParams({ fields, access_token: accessToken })}`, "Facebook video metrics");
    const insights: Record<string, number> = {};
    for (const row of j.video_insights?.data ?? []) {
      const v = row.values?.[0]?.value;
      if (typeof v === "number") insights[row.name] = v;
    }
    return {
      views: insights.total_video_views,
      likes: j.likes?.summary?.total_count,
      comments: j.comments?.summary?.total_count,
      shares: j.shares?.count,
      avgViewDurationS: insights.total_video_avg_time_watched !== undefined ? insights.total_video_avg_time_watched / 1000 : undefined,
      raw: j,
    };
  }
}
