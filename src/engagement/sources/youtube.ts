import { httpFailure } from "../../publish/types.js";
import type { CommentSource, FetchedComment } from "../types.js";

type FetchLike = typeof fetch;
const API = "https://www.googleapis.com/youtube/v3";

/**
 * YouTube Data API v3 commentThreads/comments. Hiding uses comments.setModerationStatus (we have
 * moderator rights on our own channel's videos). Not yet run against a live channel.
 */
export class YouTubeCommentSource implements CommentSource {
  readonly platform = "youtube" as const;
  readonly supportsHide = true;
  constructor(private readonly token: () => Promise<string>, private readonly f: FetchLike = fetch) {}

  async fetchComments(externalId: string): Promise<FetchedComment[]> {
    const accessToken = await this.token();
    const res = await this.f(`${API}/commentThreads?${new URLSearchParams({ part: "snippet", videoId: externalId, order: "time", maxResults: "20", textFormat: "plainText" })}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw httpFailure("YouTube commentThreads", res.status, text);
    const j = JSON.parse(text);
    return (j.items ?? [])
      .map((t: any) => {
        const top = t.snippet?.topLevelComment;
        const s = top?.snippet ?? {};
        return { externalId: top?.id ? String(top.id) : "", author: s.authorDisplayName ?? "", authorId: s.authorChannelId?.value ?? "", text: s.textOriginal ?? "", postedAt: s.publishedAt ? new Date(s.publishedAt) : null };
      })
      .filter((c: FetchedComment) => c.externalId);
  }

  async reply(commentId: string, text: string): Promise<string> {
    const accessToken = await this.token();
    const res = await this.f(`${API}/comments?part=snippet`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } }), signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (!res.ok) throw httpFailure("YouTube reply", res.status, body);
    return String(JSON.parse(body).id);
  }

  async hide(commentId: string): Promise<void> {
    const accessToken = await this.token();
    const res = await this.f(`${API}/comments/setModerationStatus?${new URLSearchParams({ id: commentId, moderationStatus: "rejected" })}`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw httpFailure("YouTube hide", res.status, await res.text());
  }
}
