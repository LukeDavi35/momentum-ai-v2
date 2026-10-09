import { XMLParser } from "fast-xml-parser";
import type { FetchLike, RawItem } from "./types.js";
import { fetchText } from "./rss.js";
import { stripHtml, truncate } from "./text.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: any): string => (v === undefined || v === null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v));

/** "200K+" / "1M+" / "5,000+" -> number */
export function parseApproxTraffic(s: string): number {
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KkMm]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  return Math.round(m[2]!.toLowerCase() === "m" ? n * 1_000_000 : m[2]!.toLowerCase() === "k" ? n * 1_000 : n);
}

/**
 * Parses Google's public "trending searches" RSS. These are TOPIC SIGNALS (kind "trend"):
 * they tell us what people are searching, never what is factually true, so they can't be cited.
 * Only entries matching the configured sport/fitness keywords are kept.
 */
export function parseTrends(xml: string, keywords: string[]): RawItem[] {
  const doc = parser.parse(xml);
  const out: RawItem[] = [];
  for (const it of arr<any>(doc?.rss?.channel?.item)) {
    const title = str(it.title);
    if (!title) continue;
    const news = arr<any>(it["ht:news_item"]);
    const context = news.map((n) => `${str(n["ht:news_item_title"])} ${str(n["ht:news_item_snippet"])}`).join(" ");
    const haystack = `${title} ${context}`.toLowerCase();
    if (!keywords.some((k) => haystack.includes(k.toLowerCase()))) continue;
    const pub = str(it.pubDate);
    out.push({
      source: "google-trends",
      kind: "trend",
      title,
      summary: truncate(stripHtml(context), 400),
      url: str(it.link) || undefined,
      publishedAt: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : undefined,
      metrics: { traffic: parseApproxTraffic(str(it["ht:approx_traffic"])) },
    });
  }
  return out;
}

export async function fetchTrends(url: string, keywords: string[], fetchImpl: FetchLike = fetch): Promise<RawItem[]> {
  return parseTrends(await fetchText(url, fetchImpl), keywords);
}
