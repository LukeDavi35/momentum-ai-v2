import type { Pillar } from "../config/index.js";
import type { FetchLike, RawItem } from "./types.js";
import { truncate } from "./text.js";

export interface RedditAuth {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

/** App-only OAuth token via the official Reddit Data API. */
export async function getRedditToken(auth: RedditAuth, fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": auth.userAgent,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Reddit token HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("Reddit token response had no access_token");
  return j.access_token;
}

/**
 * Hot posts of a subreddit as TOPIC SIGNALS. Post bodies are deliberately NOT stored and user
 * text is never quoted: we keep the title (what people are discussing) and engagement numbers.
 */
export function parseSubreddit(json: any, subreddit: string, pillar: Pillar | undefined): RawItem[] {
  const out: RawItem[] = [];
  for (const child of json?.data?.children ?? []) {
    const d = child?.data;
    if (!d || d.stickied || d.over_18 || !d.title) continue;
    out.push({
      source: `reddit/r/${subreddit}`,
      kind: "reddit",
      pillar,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
      title: truncate(String(d.title), 300),
      summary: "",
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000) : undefined,
      metrics: { score: Number(d.score ?? 0), comments: Number(d.num_comments ?? 0), upvoteRatio: Number(d.upvote_ratio ?? 0) },
    });
  }
  return out;
}

export async function fetchSubreddit(
  token: string,
  userAgent: string,
  subreddit: string,
  pillar: Pillar | undefined,
  limit: number,
  fetchImpl: FetchLike = fetch,
): Promise<RawItem[]> {
  const res = await fetchImpl(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/hot?limit=${limit}&raw_json=1`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Reddit r/${subreddit} HTTP ${res.status}`);
  return parseSubreddit(await res.json(), subreddit, pillar);
}
