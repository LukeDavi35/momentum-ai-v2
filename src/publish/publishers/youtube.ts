import { readFileSync, statSync } from "node:fs";
import { httpFailure, PublishError, type Metrics, type PublishRequest, type PublishResult, type Publisher } from "../types.js";

type FetchLike = typeof fetch;

/**
 * YouTube Data API v3 — resumable upload of a Short, declared as synthetic media.
 * NOTE: uploads from API projects that have not passed YouTube's compliance audit are locked to
 * PRIVATE regardless of the privacyStatus requested (see SETUP_CHECKLIST.md). Written to the
 * documented API; not yet run against a live channel.
 */
export class YouTubePublisher implements Publisher {
  readonly platform = "youtube" as const;
  readonly live = true;
  constructor(
    private readonly token: () => Promise<string>,
    private readonly f: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(req: PublishRequest): Promise<PublishResult> {
    const at = await this.token();
    const size = statSync(req.videoPath).size;
    const description = /#shorts/i.test(req.meta.caption) ? req.meta.caption : `${req.meta.caption}\n#Shorts`;

    await req.assertLive(); // last gate before anything irreversible
    const start = await this.f("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        authorization: `Bearer ${at}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title: req.meta.title, description, tags: req.meta.hashtags, categoryId: "17", defaultLanguage: "en", defaultAudioLanguage: "en" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: req.meta.aiDisclosure.applied },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!start.ok) throw httpFailure("YouTube upload start", start.status, await start.text());
    const location = start.headers.get("location");
    if (!location) throw new PublishError("YouTube returned no resumable upload URL", { retryable: true });

    let up: Response;
    try {
      up = await this.f(location, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(size) }, body: readFileSync(req.videoPath), signal: AbortSignal.timeout(300_000) });
    } catch (e) {
      // the bytes may have been fully received before the connection dropped
      throw new PublishError(`YouTube upload outcome unknown: ${(e as Error).message}`, { retryable: false, ambiguous: true });
    }
    if (!up.ok) {
      if (up.status >= 500) throw new PublishError(`YouTube upload outcome unknown: HTTP ${up.status}`, { retryable: false, ambiguous: true });
      throw httpFailure("YouTube upload", up.status, await up.text());
    }
    const video = (await up.json()) as { id?: string; status?: { privacyStatus?: string } };
    if (!video.id) throw new PublishError("YouTube upload returned no video id", { retryable: false, ambiguous: true });

    const warnings: string[] = [];
    if (video.status?.privacyStatus && video.status.privacyStatus !== "public") warnings.push(`YouTube set privacyStatus=${video.status.privacyStatus} (unaudited API project?)`);
    if (req.coverPath) {
      try {
        const t = await this.f(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, { method: "POST", headers: { authorization: `Bearer ${at}`, "content-type": "image/jpeg" }, body: readFileSync(req.coverPath), signal: AbortSignal.timeout(60_000) });
        if (!t.ok) warnings.push(`custom thumbnail not set (HTTP ${t.status}; needs a verified channel)`);
      } catch (e) {
        warnings.push(`custom thumbnail not set: ${(e as Error).message}`);
      }
    }
    return { externalId: video.id, url: `https://www.youtube.com/shorts/${video.id}`, warnings };
  }

  async metrics(externalId: string, ctx?: { publishedAt?: Date }): Promise<Metrics> {
    const at = await this.token();
    const headers = { authorization: `Bearer ${at}` };
    const stats = await this.f(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${externalId}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!stats.ok) throw httpFailure("YouTube statistics", stats.status, await stats.text());
    const s = ((await stats.json()) as any).items?.[0]?.statistics ?? {};
    const out: Metrics = { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), raw: { statistics: s } };

    // Retention/watch-time need the Analytics API (extra scope; data lags 24-48h). Best effort, never fatal.
    try {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const start = ctx?.publishedAt ? day(new Date(ctx.publishedAt.getTime() - 86400_000)) : "2020-01-01";
      const r = await this.f(
        `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: day(this.now()), metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained", filters: `video==${externalId}` })}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      if (r.ok) {
        const row = ((await r.json()) as any).rows?.[0];
        if (row) {
          out.watchTimeS = row[1] * 60;
          out.avgViewDurationS = row[2];
          out.retentionPct = row[3];
          out.shares = row[4];
          out.follows = row[5];
          (out.raw as any).analytics = row;
        }
      }
    } catch {
      /* analytics not available yet */
    }
    return out;
  }
}

const num = (v: unknown): number | undefined => (v === undefined || v === null || Number.isNaN(Number(v)) ? undefined : Number(v));
