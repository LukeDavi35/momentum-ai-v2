import { readFileSync, statSync } from "node:fs";
import { httpFailure, PublishError, type Metrics, type PublishRequest, type PublishResult, type Publisher } from "../types.js";

type FetchLike = typeof fetch;
const API = "https://open.tiktokapis.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * TikTok Content Posting API (Direct Post, FILE_UPLOAD).
 * Flow: creator_info/query -> video/init -> PUT bytes -> status/fetch.
 * IMPORTANT: until TikTok audits the app, direct posts are forced to SELF_ONLY (private) and the
 * account must be private. The publisher uses PUBLIC_TO_EVERYONE only when creator_info offers it.
 * Written to the documented API; not yet run against a live app.
 */
export class TikTokPublisher implements Publisher {
  readonly platform = "tiktok" as const;
  readonly live = true;
  constructor(
    private readonly token: () => Promise<string>,
    private readonly f: FetchLike = fetch,
    private readonly pollMs = 5000,
    private readonly maxPolls = 40,
  ) {}

  private async call(path: string, body: unknown, accessToken: string, what: string): Promise<any> {
    const res = await this.f(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw httpFailure(what, res.status, text);
    const j = JSON.parse(text);
    if (j.error?.code && j.error.code !== "ok") {
      const code = String(j.error.code);
      const transient = ["rate_limit_exceeded", "internal_error", "service_unavailable"].includes(code);
      throw new PublishError(`${what} failed: ${code} ${j.error.message ?? ""}`, { retryable: transient });
    }
    return j;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const at = await this.token();
    const warnings: string[] = [];

    const info = await this.call("/v2/post/publish/creator_info/query/", {}, at, "TikTok creator_info");
    const options: string[] = info.data?.privacy_level_options ?? [];
    const maxDur: number | undefined = info.data?.max_video_post_duration_sec;
    if (maxDur && req.durationS > maxDur) throw new PublishError(`video is ${req.durationS}s but this TikTok account allows ${maxDur}s`, { retryable: false });
    let privacy = "PUBLIC_TO_EVERYONE";
    if (!options.includes("PUBLIC_TO_EVERYONE")) {
      privacy = options.includes("SELF_ONLY") ? "SELF_ONLY" : (options[0] ?? "SELF_ONLY");
      warnings.push(`TikTok only offered privacy level(s) [${options.join(", ")}]; posted as ${privacy} (the app is probably unaudited — see SETUP_CHECKLIST.md)`);
    }

    const size = statSync(req.videoPath).size;
    // single-chunk upload: allowed for files up to 64 MB (ours are a few MB). Larger files would need chunking.
    if (size > 64 * 1024 * 1024) throw new PublishError(`video is ${size} bytes; chunked upload is not implemented`, { retryable: false });

    await req.assertLive(); // last gate before anything irreversible
    const init = await this.call(
      "/v2/post/publish/video/init/",
      {
        post_info: {
          title: req.meta.caption,
          privacy_level: privacy,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
          brand_content_toggle: false,
          brand_organic_toggle: false,
          is_aigc: req.meta.aiDisclosure.applied,
        },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
      },
      at,
      "TikTok init",
    );
    const publishId: string | undefined = init.data?.publish_id;
    const uploadUrl: string | undefined = init.data?.upload_url;
    if (!publishId || !uploadUrl) throw new PublishError("TikTok init returned no publish_id/upload_url", { retryable: true });

    const up = await this.f(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` },
      body: readFileSync(req.videoPath),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => {
      throw new PublishError(`TikTok upload failed: ${(e as Error).message}`, { retryable: true });
    });
    if (up.status !== 201 && up.status !== 200 && up.status !== 206) throw httpFailure("TikTok upload", up.status, await up.text());

    // The post exists on TikTok's side from here on. Failing to confirm it is therefore AMBIGUOUS, never retryable.
    for (let i = 0; i < this.maxPolls; i++) {
      await sleep(this.pollMs);
      let st: any;
      try {
        st = await this.call("/v2/post/publish/status/fetch/", { publish_id: publishId }, at, "TikTok status");
      } catch {
        continue;
      }
      const status: string = st.data?.status;
      if (status === "PUBLISH_COMPLETE") {
        const postId = st.data?.publicaly_available_post_id?.[0] ?? st.data?.publicly_available_post_id?.[0];
        return { externalId: postId ? String(postId) : `publish:${publishId}`, warnings };
      }
      if (status === "FAILED") throw new PublishError(`TikTok publish failed: ${st.data?.fail_reason ?? "unknown"}`, { retryable: false });
      if (status === "SEND_TO_USER_INBOX") return { externalId: `publish:${publishId}`, warnings: [...warnings, "sent to the user's TikTok inbox as a draft, not posted"] };
    }
    throw new PublishError(`TikTok publish ${publishId} not confirmed after polling`, { retryable: false, ambiguous: true });
  }

  async metrics(externalId: string, ctx?: { caption?: string }): Promise<Metrics> {
    const at = await this.token();
    const fields = "id,title,view_count,like_count,comment_count,share_count,create_time";
    let id = externalId;
    if (externalId.startsWith("publish:")) {
      // we only have the publish_id; find the video by caption among the account's recent videos
      const list = await this.call(`/v2/video/list/?fields=${fields}`, { max_count: 20 }, at, "TikTok video list");
      const want = (ctx?.caption ?? "").slice(0, 40);
      const hit = (list.data?.videos ?? []).find((v: any) => want && String(v.title ?? "").startsWith(want));
      if (!hit) return { raw: { note: "video not yet listed" } };
      id = String(hit.id);
    }
    const j = await this.call(`/v2/video/query/?fields=${fields}`, { filters: { video_ids: [id] } }, at, "TikTok video query");
    const v = j.data?.videos?.[0];
    if (!v) return { raw: j };
    // The TikTok API exposes no watch time / retention / saves / follows; those stay undefined (never faked).
    return { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count, raw: v };
  }
}
