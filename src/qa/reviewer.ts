import { z } from "zod";
import type { Content } from "../db/content.js";
import { BRAND_VOICE } from "../prompts.js";
import type { Deps } from "../queue/types.js";
import type { ScriptDoc } from "../script/types.js";
import { narrationOf } from "../script/types.js";
import type { ClaimVerdict } from "./factcheck.js";

export const SCORE_KEYS = ["accuracy", "brand_voice", "hook_strength", "clarity", "policy_safety"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

const score = z.number().min(1).max(10);
export const reviewSchema = z.object({
  scores: z.object({ accuracy: score, brand_voice: score, hook_strength: score, clarity: score, policy_safety: score }),
  feedback: z.array(z.string().max(400)).max(10).default([]),
});
export type Review = z.infer<typeof reviewSchema>;

/** Deliberately a different system prompt from the writer's: the reviewer never sees the writer's instructions. */
const REVIEWER_SYSTEM = `You are an independent quality reviewer for a sports & fitness short-video brand. You did NOT write this script and you are not trying to be encouraging: you are the last check before it is published automatically with nobody watching.
Score each dimension from 1 (unacceptable) to 10 (excellent). Be strict and use the whole range:
- accuracy: every factual statement is supported by the provided claim verdicts/sources; nothing invented, exaggerated or misleading. Any unverified claim caps this at 4.
- brand_voice: credible, energetic, plain-spoken, respectful; no clickbait the facts can't support.
- hook_strength: the first beat grabs attention within ~2 seconds AND is truthful.
- clarity: easy to follow when heard once, logical flow, no jargon without explanation, a clear ending.
- policy_safety: no individual medical/injury/diet/supplement advice, no unrealistic promises, nothing hateful or dangerous, appropriate to post on TikTok/Instagram/YouTube.
Give concrete, actionable "feedback" items for anything scoring below 8. Respond with ONLY JSON: {"scores":{"accuracy":0,"brand_voice":0,"hook_strength":0,"clarity":0,"policy_safety":0},"feedback":["..."]}`;

export interface ReviewContext {
  content: Content;
  script: ScriptDoc;
  verdicts: ClaimVerdict[];
  flaggedBeats: number;
  policyViolations: string[];
  hookWords: number;
}

export async function reviewScript(deps: Deps, ctx: ReviewContext): Promise<Review> {
  const { content, script, verdicts } = ctx;
  const claimLines = script.claims.map((c) => {
    const v = verdicts.find((x) => x.id === c.id);
    return `- [${v?.verified ? "VERIFIED" : "UNVERIFIED"}] ${c.id} (${c.kind}): ${c.text}`;
  });
  const prompt = `Template: ${content.template} | Pillar: ${content.pillar} | Topic: ${content.topic}

Brand standard (for reference):
${BRAND_VOICE}

HOOK (beat 1): ${script.beats[0]?.text ?? "(none)"}

FULL NARRATION:
${narrationOf(script)}

CLAIMS AND VERIFICATION RESULTS:
${claimLines.join("\n") || "(none)"}

AUTOMATIC CHECKS: ${ctx.policyViolations.length ? `policy issues: ${ctx.policyViolations.join("; ")}` : "no policy issues"}; ${ctx.flaggedBeats} beats flagged for unsourced specifics.
Estimated spoken length: ${script.estimatedDurationS}s.

Review it.`;
  return deps.llm.json({
    task: "qa.review",
    role: "reviewer",
    system: REVIEWER_SYSTEM,
    prompt,
    schema: reviewSchema,
    maxTokens: 900,
    temperature: 0.1,
    input: {
      hookWords: ctx.hookWords,
      unverifiedClaims: verdicts.filter((v) => !v.verified).length,
      flaggedBeats: ctx.flaggedBeats,
      policyViolations: ctx.policyViolations,
      beats: script.beats.length,
      estimatedDurationS: script.estimatedDurationS,
    },
    contentId: content.id,
    correlationId: content.correlationId,
  });
}

export function belowThreshold(scores: Review["scores"], min: number): Array<{ key: ScoreKey; value: number }> {
  return SCORE_KEYS.filter((k) => scores[k] < min).map((k) => ({ key: k, value: scores[k] }));
}
