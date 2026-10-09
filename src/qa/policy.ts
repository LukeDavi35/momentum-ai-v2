import { PLATFORMS, type Platform } from "../config/index.js";
import { LIMITS, type PlatformMetadata } from "../publish/metadata.js";
import type { ScriptDoc } from "../script/types.js";
import { narrationOf } from "../script/types.js";

export interface PolicyViolation {
  rule: string;
  where: string;
  excerpt: string;
}

interface Rule {
  rule: string;
  re: RegExp;
  why: string;
}

/**
 * Deterministic guard rails. They are intentionally blunt: a false positive costs one regeneration,
 * a false negative publishes something we shouldn't. The LLM reviewer's policy_safety score is a
 * second, subtler layer on top of these.
 */
export const TEXT_RULES: Rule[] = [
  { rule: "medical_advice", re: /\b(you should|you must|make sure you|try)\b[^.!?]{0,50}\b(take|taking|stop taking|dose|dosage)\b[^.!?]{0,40}\b(mg|ibuprofen|paracetamol|aspirin|painkillers?|supplements?|creatine|steroids?|medication|pills?)\b/i, why: "dosage / medication advice" },
  { rule: "medical_advice", re: /\b(diagnos(e|ed|is|ing)|this (will )?cures?|cures? (your|an?|the)|treat(s|ing)? (your|an?|the) (injury|pain|condition|tendon|knee|back))\b/i, why: "diagnosis or treatment claim" },
  { rule: "medical_advice", re: /\b(train|run|push|work) through (the )?(pain|injury)\b|\bignore (the |your )?pain\b|\bno pain,? no gain\b/i, why: "encourages training through pain/injury" },
  { rule: "medical_advice", re: /\bif you(?:'re| are| have)? (injured|in pain|hurt|have an injury)\b[^.!?]{0,60}\b(you should|do this|try this|just)\b/i, why: "individual injury advice" },
  { rule: "guaranteed_results", re: /\bguarantee[sd]?\b|\b(lose|drop|burn) \d+\s*(kg|kilos?|lbs?|pounds?|stone)\b[^.!?]{0,20}\b(in|within)\b|\bget (shredded|abs) in \d+/i, why: "guaranteed / unrealistic result claim" },
  { rule: "doping", re: /\b(how to|best way to|where to (buy|get))\b[^.!?]{0,40}\b(steroids?|epo|hgh|peds?|doping|banned substances?)\b|\b(use|take|stack)\b[^.!?]{0,20}\b(steroids?|epo|hgh)\b/i, why: "doping instruction" },
  { rule: "hate_or_abuse", re: /\b(retard(ed)?|faggot|nigg(er|a)s?|spastic|kill yourself)\b/i, why: "slur / abusive language" },
  { rule: "profanity", re: /\b(fuck(ing)?|shit(ty)?|bastard|cunt)\b/i, why: "profanity" },
];

function scan(text: string, where: string, out: PolicyViolation[]): void {
  for (const r of TEXT_RULES) {
    const m = text.match(r.re);
    if (m) out.push({ rule: r.rule, where, excerpt: `${r.why}: "${m[0].slice(0, 80)}"` });
  }
}

export function checkMetadata(platform: Platform, m: PlatformMetadata): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const where = `metadata:${platform}`;
  if (!m.aiDisclosure.applied || !m.caption.includes(m.aiDisclosure.line)) v.push({ rule: "ai_disclosure", where, excerpt: "AI disclosure line missing from the post text" });
  if (platform === "tiktok") {
    if (m.caption.length > LIMITS.tiktok.caption) v.push({ rule: "limits", where, excerpt: `caption ${m.caption.length} > ${LIMITS.tiktok.caption} chars` });
  } else if (platform === "instagram") {
    if (m.caption.length > LIMITS.instagram.caption) v.push({ rule: "limits", where, excerpt: `caption ${m.caption.length} > ${LIMITS.instagram.caption} chars` });
    if (m.hashtags.length > LIMITS.instagram.maxHashtags) v.push({ rule: "limits", where, excerpt: `${m.hashtags.length} hashtags > ${LIMITS.instagram.maxHashtags}` });
  } else {
    if (m.title.length === 0) v.push({ rule: "limits", where, excerpt: "empty YouTube title" });
    if (m.title.length > LIMITS.youtube.title) v.push({ rule: "limits", where, excerpt: `title ${m.title.length} > ${LIMITS.youtube.title} chars` });
    if (m.caption.length > LIMITS.youtube.description) v.push({ rule: "limits", where, excerpt: `description ${m.caption.length} > ${LIMITS.youtube.description} chars` });
  }
  if (m.hashtags.some((t) => !/^[\p{L}\p{N}_]+$/u.test(t))) v.push({ rule: "limits", where, excerpt: "hashtag contains invalid characters" });
  scan(`${m.title}\n${m.caption}`, where, v);
  return v;
}

/** On-screen text must fit the template: a long headline wraps past the chips/stat and overlaps them. */
export const LAYOUT_LIMITS = { headline: 70, item: 60, stat: 14 } as const;

export function checkLayout(script: ScriptDoc): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const over = (what: string, text: string | null | undefined, max: number) => {
    if (text && text.length > max) v.push({ rule: "layout", where: "visual", excerpt: `${what} is ${text.length} chars (max ${max}) and would overflow the layout: "${text.slice(0, 40)}…"` });
  };
  over("headline", script.visual.headline, LAYOUT_LIMITS.headline);
  over("stat", script.visual.stat, LAYOUT_LIMITS.stat);
  for (const it of script.visual.items ?? []) over("item", it, LAYOUT_LIMITS.item);
  return v;
}

export function checkPolicy(script: ScriptDoc, metadata: Partial<Record<Platform, PlatformMetadata>>, enabled: readonly Platform[] = PLATFORMS): { passed: boolean; violations: PolicyViolation[] } {
  const violations: PolicyViolation[] = [];
  scan(narrationOf(script), "narration", violations);
  for (const b of script.beats) if (b.onScreen) scan(b.onScreen, `onScreen:${b.id}`, violations);
  violations.push(...checkLayout(script));
  scan(`${script.title}\n${script.visual.headline}\n${(script.visual.items ?? []).join("\n")}`, "title/visual", violations);
  for (const p of enabled) {
    const m = metadata[p];
    if (!m) {
      violations.push({ rule: "ai_disclosure", where: `metadata:${p}`, excerpt: "no metadata built for enabled platform" });
      continue;
    }
    violations.push(...checkMetadata(p, m));
  }
  return { passed: violations.length === 0, violations };
}
