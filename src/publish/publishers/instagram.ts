import { httpFailure, PublishError, type Metrics, type PublishRequest, type PublishResult, type Publisher } from "../types.js";

type FetchLike = typeof fetch;
const GRAPH = "https://graph.instagram.com/v23.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Instagram API with Instagram Login — Reels via the two-step container flow:
 *   POST /{ig-user-id}/media (REELS, video_url) -> poll status_code -> POST /{ig-user-id}/media_publish.
 * Instagram FETCHES the video, so `mediaUrl` must be a public HTTPS URL (see the signed /media route).
 * Written to the documented API; not yet run against a live account.
 */
export class InstagramPublisher implements Publisher {
  readonly platform = "instagram" as const;
  readonly live = true;
  constructor(
    private readonly token: () => Promise<{ accessToken: string; accountId: string }>,
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
    if (!req.mediaUrl) throw new PublishError("Instagram needs a public mediaUrl (set PUBLIC_BASE_URL)", { retryable: false });
    const { accessToken, accountId } = await this.token();
    if (req.durationS > 90) throw new PublishError(`Reels via API are limited to 90s (video is ${req.durationS}s)`, { retryable: false });

    // respect Instagram's own rolling 24h publishing quota
    try {
      const q = await this.getJson(`${GRAPH}/${accountId}/content_publishing_limit?${new URLSearchParams({ fields: "quota_usage,config", access_token: accessToken })}`, "Instagram publishing limit");
      const row = q.data?.[0];
      if (row && row.config?.quota_total && row.quota_usage >= row.config.quota_total) throw new PublishError(`Instagram publishing quota used (${row.quota_usage}/${row.config.quota_total})`, { retryable: true });
    } catch (e) {
      if (e instanceof PublishError && /quota used/.test(e.message)) throw e; // other lookup failures are non-fatal
    }

    const created = await this.postForm(`${GRAPH}/${accountId}/media`, {
      media_type: "REELS",
      video_url: req.mediaUrl,
      caption: req.meta.caption,
      share_to_feed: "true",
      ...(req.coverUrl ? { cover_url: req.coverUrl } : {}),
      access_token: accessToken,
    }, "Instagram create container");
    const container: string | undefined = created.id;
    if (!container) throw new PublishError("Instagram returned no container id", { retryable: true });

    for (let i = 0; ; i++) {
      if (i >= this.maxPolls) throw new PublishError(`Instagram container ${container} still processing after polling`, { retryable: true });
      const s = await this.getJson(`${GRAPH}/${container}?${new URLSearchParams({ fields: "status_code,status", access_token: accessToken })}`, "Instagram container status");
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PublishError(`Instagram container ${s.status_code}: ${s.status ?? ""}`, { retryable: s.status_code === "EXPIRED" });
      await sleep(this.pollMs);
    }

    await req.assertLive(); // last gate before the irreversible publish
    let mediaId: string;
    try {
      const pub = await this.postForm(`${GRAPH}/${accountId}/media_publish`, { creation_id: container, access_token: accessToken }, "Instagram media_publish");
      mediaId = pub.id;
    } catch (e) {
      // a timeout/5xx here may still have published: never auto-retry
      if (e instanceof PublishError && e.opts.status !== undefined && e.opts.status < 500 && e.opts.status !== 429) throw e;
      throw new PublishError(`Instagram media_publish outcome unknown: ${(e as Error).message}`, { retryable: false, ambiguous: true });
    }
    let url: string | undefined;
    try {
      url = (await this.getJson(`${GRAPH}/${mediaId}?${new URLSearchParams({ fields: "permalink", access_token: accessToken })}`, "Instagram permalink")).permalink;
    } catch {
      /* permalink is cosmetic */
    }
    return { externalId: String(mediaId), url };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const { accessToken } = await this.token();
    const wanted = ["views", "reach", "saved", "shares", "likes", "comments", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
    let metrics = wanted;
    let data: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(`${GRAPH}/${externalId}/insights?${new URLSearchParams({ metric: metrics.join(","), access_token: accessToken })}`, { signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.ok) {
        data = JSON.parse(text);
        break;
      }
      // Instagram rejects the WHOLE request if one metric is unsupported for the media: drop it and retry
      const bad = text.match(/metric[s]?\s+\[?([a-z_]+)\]?.*(not supported|invalid)/i)?.[1] ?? metrics.find((m) => text.includes(m));
      if (res.status === 400 && bad && metrics.includes(bad)) {
        metrics = metrics.filter((m) => m !== bad);
        continue;
      }
      throw httpFailure("Instagram insights", res.status, text);
    }
    const byName = Object.fromEntries((data?.data ?? []).map((m: any) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
    const n = (k: string): number | undefined => (typeof byName[k] === "number" ? byName[k] : undefined);
    return {
      views: n("views"),
      likes: n("likes"),
      comments: n("comments"),
      shares: n("shares"),
      saves: n("saved"),
      avgViewDurationS: n("ig_reels_avg_watch_time") !== undefined ? n("ig_reels_avg_watch_time")! / 1000 : undefined, // ms -> s
      watchTimeS: n("ig_reels_video_view_total_time") !== undefined ? n("ig_reels_video_view_total_time")! / 1000 : undefined,
      raw: byName,
    };
  }
}
