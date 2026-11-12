import type { Platform } from "../config/index.js";
import { classifyLicense } from "../footage/licenses.js";
import { ILLUSTRATIVE_NOTE } from "../footage/query.js";
import type { PlatformMetadata } from "../publish/metadata.js";
import type { ScriptDoc } from "../script/types.js";
import type { PolicyViolation } from "./policy.js";

export const MIN_STORIES = 2;

/**
 * Compilation-specific gate (daily_highlights only). Footage is the one thing in this system we did not generate, so
 * the rules are strict: every clip must still carry an accepted licence, be credited, and the posts must say it is
 * illustrative footage (it is stock/archive b-roll of the sport, not of the events narrated).
 */
export function checkCompilation(script: ScriptDoc, metadata: Partial<Record<Platform, PlatformMetadata>>, enabled: readonly Platform[]): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  const c = script.compilation;
  if (!c) return [{ rule: "compilation", where: "script", excerpt: "a daily_highlights piece has no compilation plan" }];
  if (c.segments.length < MIN_STORIES) v.push({ rule: "compilation", where: "script", excerpt: `only ${c.segments.length} story segment(s) survived; a compilation needs at least ${MIN_STORIES}` });

  const credits: string[] = [];
  for (const seg of c.segments) {
    const f = seg.footage;
    if (!f) continue;
    if (!classifyLicense(f.licenseLabel)) v.push({ rule: "footage_license", where: `segment:${seg.storyIndex}`, excerpt: `clip ${f.provider}:${f.externalId} has licence "${f.licenseLabel}", which is not an accepted licence` });
    if (!f.credit.trim()) v.push({ rule: "footage_credit", where: `segment:${seg.storyIndex}`, excerpt: `clip ${f.provider}:${f.externalId} has no credit line` });
    else credits.push(f.credit);
  }
  if (credits.length > 0) {
    for (const p of enabled) {
      const m = metadata[p];
      if (!m) continue;
      for (const line of new Set(credits)) if (!m.caption.includes(line)) v.push({ rule: "footage_credit", where: `metadata:${p}`, excerpt: `footage credit missing from the post text: "${line}"` });
      if (!m.caption.includes(ILLUSTRATIVE_NOTE)) v.push({ rule: "footage_credit", where: `metadata:${p}`, excerpt: "post text does not say the footage is illustrative" });
    }
  }
  return v;
}
