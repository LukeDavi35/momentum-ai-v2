import { XMLParser } from "fast-xml-parser";
import type { Pillar } from "../config/index.js";
import type { FetchLike, RawItem, SourceKind } from "./types.js";
import { stripHtml, truncate } from "./text.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, trimValues: true });

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: any): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return String(v["#text"] ?? "");
  return "";
};

export interface FeedMeta {
  id: string;
  pillar?: Pillar;
  kind: SourceKind;
}

/** Parses RSS 2.0 and Atom into RawItems. Pure function — tested with fixtures. */
export function parseFeed(xml: string, meta: FeedMeta): RawItem[] {
  const doc = parser.parse(xml);
  const items: RawItem[] = [];

  const rssItems = arr(doc?.rss?.channel?.item);
  for (const it of rssItems) {
    const title = stripHtml(text(it.title));
    if (!title) continue;
    const desc = stripHtml(text(it.description));
    const content = stripHtml(text(it["content:encoded"]));
    const pub = text(it.pubDate) || text(it["dc:date"]);
    items.push({
      source: meta.id,
      kind: meta.kind,
      pillar: meta.pillar,
      url: text(it.link) || text(it.guid) || undefined,
      title,
      summary: truncate(desc || content, 600),
      bodyText: truncate(content || desc, 4000),
      publishedAt: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : undefined,
    });
  }

  const atomEntries = arr(doc?.feed?.entry);
  for (const e of atomEntries) {
    const title = stripHtml(text(e.title));
    if (!title) continue;
    const links = arr(e.link);
    const href = (links.find((l: any) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0])?.["@_href"];
    const summary = stripHtml(text(e.summary) || text(e.content));
    const pub = text(e.published) || text(e.updated);
    items.push({
      source: meta.id,
      kind: meta.kind,
      pillar: meta.pillar,
      url: href,
      title,
      summary: truncate(summary, 600),
      bodyText: truncate(stripHtml(text(e.content)) || summary, 4000),
      publishedAt: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : undefined,
    });
  }
  return items;
}

export async function fetchText(url: string, fetchImpl: FetchLike = fetch, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { "user-agent": "momentum-ai-v2/2.0 (+feed reader)", accept: "application/rss+xml, application/xml, text/xml, */*", ...headers },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  if (body.length > 5_000_000) throw new Error(`Feed too large: ${url}`);
  return body;
}

export async function fetchRss(feed: FeedMeta & { url: string }, fetchImpl: FetchLike = fetch): Promise<RawItem[]> {
  return parseFeed(await fetchText(feed.url, fetchImpl), feed);
}
