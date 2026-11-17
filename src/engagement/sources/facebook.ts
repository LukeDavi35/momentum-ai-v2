import { httpFailure } from "../../publish/types.js";
import type { CommentSource, FetchedComment } from "../types.js";

type FetchLike = typeof fetch;
const GRAPH = "https://graph.facebook.com/v23.0";

/** Facebook Graph API Page-post comments. Not yet run against a live Page. */
export class FacebookCommentSource implements CommentSource {
  readonly platform = "facebook" as const;
  readonly supportsHide = true;
  constructor(private readonly token: () => Promise<string>, private readonly f: FetchLike = fetch) {}

  async fetchComments(externalId: string): Promise<FetchedComment[]> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${externalId}/comments?${new URLSearchParams({ filter: "toplevel", fields: "id,message,from,created_time", access_token: accessToken })}`, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw httpFailure("Facebook comments", res.status, text);
    const j = JSON.parse(text);
    return (j.data ?? []).map((c: any) => ({ externalId: String(c.id), author: c.from?.name ?? "", authorId: c.from?.id ?? "", text: c.message ?? "", postedAt: c.created_time ? new Date(c.created_time) : null }));
  }

  async reply(commentId: string, text: string): Promise<string> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${commentId}/comments`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: text, access_token: accessToken }), signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (!res.ok) throw httpFailure("Facebook reply", res.status, body);
    return String(JSON.parse(body).id);
  }

  async hide(commentId: string): Promise<void> {
    const accessToken = await this.token();
    const res = await this.f(`${GRAPH}/${commentId}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ is_hidden: "true", access_token: accessToken }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw httpFailure("Facebook hide", res.status, await res.text());
  }
}
