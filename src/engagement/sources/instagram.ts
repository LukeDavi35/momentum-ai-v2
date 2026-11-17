import { httpFailure } from "../../publish/types.js";
import type { CommentSource, FetchedComment } from "../types.js";

type FetchLike = typeof fetch;
const GRAPH = "https://graph.instagram.com/v23.0";

/**
 * Instagram Graph API comments. The top-level /{media-id}/comments listing never includes our
 * own replies (those live under /{comment-id}/replies), so there's no "is this ours" filtering
 * needed here - every item returned is a genuine audience comment. Not yet run against a live
 * account.
 */
export class InstagramCommentSource implements CommentSource {
  readonly platform = "instagram" as const;
  readonly supportsHide = true;
  constructor(private readonly token: () => Promise<string>, private readonly f: FetchLike = fetch) {}

  async fetchComments(externalId: string): Promise<FetchedComment[]> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${externalId}/comments?${new URLSearchParams({ fields: "id,text,username,timestamp", access_token: accessToken })}`, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw httpFailure("Instagram comments", res.status, text);
    const j = JSON.parse(text);
    return (j.data ?? []).map((c: any) => ({ externalId: String(c.id), author: c.username ?? "", authorId: "", text: c.text ?? "", postedAt: c.timestamp ? new Date(c.timestamp) : null }));
  }

  async reply(commentId: string, text: string): Promise<string> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${commentId}/replies`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: text, access_token: accessToken }), signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (!res.ok) throw httpFailure("Instagram reply", res.status, body);
    return String(JSON.parse(body).id);
  }

  async hide(commentId: string): Promise<void> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${commentId}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hide: "true", access_token: accessToken }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw httpFailure("Instagram hide", res.status, await res.text());
  }
}
