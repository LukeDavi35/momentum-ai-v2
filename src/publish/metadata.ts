import type { Platform } from "../config/index.js";
import type { Content } from "../db/content.js";
import type { SourceItem } from "../ingest/types.js";
import { CITABLE_KINDS } from "../ingest/types.js";
import type { ScriptDoc } from "../script/types.js";

export const AI_DISCLOSURE_LINE = "AI-assisted video with a synthetic voiceover.";

const OUTLETS: Array<[RegExp, string]> = [
  [/^bbc/, "BBC Sport"],
  [/^guardian/, "The Guardian"],
  [/^espn/, "ESPN"],
];
export const outletName = (source: string): string => OUTLETS.find(([re]) => re.test(source))?.[1] ?? source;

export interface PlatformMetadata {
  platform: Platform;
  /** YouTube title; for TikTok/Instagram this is a short internal title (the caption is what is posted). */
  title: string;
  /** TikTok/Instagram post text, or the YouTube description. Always contains the AI disclosure line. */
  caption: string;
  hashtags: string[];
  aiDisclosure: { applied: boolean; line: string; nativeFlag: "is_aigc" | "containsSyntheticMedia" | "none" };
  sourceCredit: string | null;
}

export const LIMITS = {
  tiktok: { caption: 2200, hashtags: 5 },
  instagram: { caption: 2200, hashtags: 6, maxHashtags: 30 },
  youtube: { title: 100, description: 5000, hashtags: 3 },
} as const;

export const cleanTag = (t: string): string => t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");

function uniqueTags(tags: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = cleanTag(raw);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function sourceCreditFor(script: ScriptDoc, sources: SourceItem[]): { credit: string | null; urls: string[] } {
  const used = new Set(script.claims.map((c) => c.sourceItemId).filter((x): x is string => !!x));
  const cited = sources.filter((s) => used.has(s.id) && CITABLE_KINDS.includes(s.kind));
  if (cited.length === 0) return { credit: null, urls: [] };
  const names = [...new Set(cited.map((s) => outletName(s.source)))];
  return { credit: `Source: ${names.join(", ")}`, urls: [...new Set(cited.map((s) => s.url).filter((u): u is string => !!u))] };
}

export function buildPlatformMetadata(platform: Platform, content: Pick<Content, "pillar" | "topic">, script: ScriptDoc, sources: SourceItem[]): PlatformMetadata {
  const { credit, urls } = sourceCreditFor(script, sources);
  const v = script.variants;
  const nativeFlag = platform === "tiktok" ? "is_aigc" : platform === "youtube" ? "containsSyntheticMedia" : "none";
  const aiDisclosure = { applied: true, line: AI_DISCLOSURE_LINE, nativeFlag } as const;

  if (platform === "tiktok") {
    const tags = uniqueTags(v.tiktok.hashtags, LIMITS.tiktok.hashtags);
    const caption = [v.tiktok.caption.trim(), tags.map((t) => `#${t}`).join(" "), credit, AI_DISCLOSURE_LINE].filter(Boolean).join("\n");
    return { platform, title: content.topic.slice(0, 90), caption, hashtags: tags, aiDisclosure, sourceCredit: credit };
  }
  if (platform === "instagram") {
    const tags = uniqueTags(v.instagram.hashtags, LIMITS.instagram.hashtags);
    const caption = [v.instagram.caption.trim(), "", tags.map((t) => `#${t}`).join(" "), credit, AI_DISCLOSURE_LINE].filter((x) => x !== null && x !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
    return { platform, title: content.topic.slice(0, 90), caption, hashtags: tags, aiDisclosure, sourceCredit: credit };
  }
  const tags = uniqueTags(v.youtube.hashtags, LIMITS.youtube.hashtags);
  const title = v.youtube.title.trim().slice(0, LIMITS.youtube.title);
  const description = [v.youtube.description.trim(), "", credit, ...urls.slice(0, 3), "", AI_DISCLOSURE_LINE, tags.map((t) => `#${t}`).join(" ")]
    .filter((x) => x !== null && x !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { platform, title, caption: description, hashtags: tags, aiDisclosure, sourceCredit: credit };
}
