import { z } from "zod";
import type { Template } from "../config/index.js";
import { normalizeForMatch } from "../ingest/text.js";
import type { SourceItem } from "../ingest/types.js";
import type { Deps } from "../queue/types.js";
import type { Beat, Claim, ScriptDoc } from "../script/types.js";
import { narrationOf } from "../script/types.js";

export const EVERGREEN: Template[] = ["training_tip", "quick_explainer"];

export interface ClaimVerdict {
  id: string;
  verified: boolean;
  reason: string;
  method: "deterministic" | "llm" | "general";
}

// --- anchors ------------------------------------------------------------------

const STOP_CAPS = new Set(
  "The A An And But Or So If When While Then Here There This That These Those It Its He She They We You I His Her Their Our Your My Now Today Tonight Yesterday Tomorrow Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Follow Like Share Save Comment Watch Subscribe Momentum Remember Try Start Keep Focus Add Use Take Make Get Build Let Why How What Who Where Which After Before During Since Until Despite Even Still Just Only Also Both All Each Every Some Many Most More Less One Two Three Four Five Six Seven Eight Nine Ten Next First Second Third Last New Big Top Best Great".split(
    " ",
  ),
);

/** Whole numbers 0–10 are treated as incidental (list counts, "second"), everything else is a checkable figure. */
const isIncidentalInt = (n: string): boolean => /^\d+$/.test(n) && Number(n) <= 10;

export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of normalizeForMatch(text).matchAll(/\d+(?:[:.]\d+)*/g)) {
    const n = m[0].replace(/[:.]+$/, "");
    if (!isIncidentalInt(n)) out.add(n);
  }
  return [...out];
}

/** Capitalised words that look like names. Sentence-initial single words are skipped (too ambiguous). */
export function extractNames(text: string): string[] {
  const names = new Set<string>();
  const re = /(^|[.!?]\s+|\n)?(\b[A-Z][a-zA-Z'’-]{2,}(?:\s+[A-Z][a-zA-Z'’-]{2,})*)/g;
  for (const m of text.matchAll(re)) {
    const sentenceStart = m[1] !== undefined || m.index === 0;
    const words = m[2]!.split(/\s+/);
    // drop leading words that are only capitalised because they start a sentence / are common
    const kept = words.filter((w, i) => !(STOP_CAPS.has(w) || (sentenceStart && i === 0 && words.length === 1)));
    for (const w of kept) names.add(w.replace(/['’]s$/i, ""));
  }
  return [...names];
}

export function containsNumber(haystackNorm: string, num: string): boolean {
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d:.])${esc}(?!\\d)`).test(haystackNorm);
}

export const containsName = (haystackNorm: string, name: string): boolean => haystackNorm.includes(normalizeForMatch(name));

export const sourceText = (s: SourceItem): string => normalizeForMatch(`${s.title}. ${s.summary}. ${s.bodyText}`);

// --- deterministic claim check -----------------------------------------------------

export function deterministicCheck(claim: Claim, source: SourceItem | undefined, template: Template): { ok: boolean; reason: string } {
  const anchorsNum = extractNumbers(claim.text);
  const anchorsName = extractNames(claim.text);

  if (claim.kind === "general") {
    if (!EVERGREEN.includes(template)) return { ok: false, reason: "general (unsourced) claims are only allowed in training_tip / quick_explainer" };
    if (anchorsNum.length > 0 || anchorsName.length > 0) {
      return { ok: false, reason: `general claim contains specifics that need a source (${[...anchorsNum, ...anchorsName].join(", ")})` };
    }
    return { ok: true, reason: "general-interest statement with no figures or names" };
  }

  if (!source) return { ok: false, reason: "claim cites no valid source" };
  const hay = sourceText(source);

  if (claim.kind === "quote") {
    const q = normalizeForMatch(claim.quote ?? "");
    if (q.length < 8) return { ok: false, reason: "quote claim has no (or too short a) verbatim quote" };
    return hay.includes(q) ? { ok: true, reason: "verbatim quote found in source" } : { ok: false, reason: "quote not found verbatim in source (possible fabricated quote)" };
  }

  const missingNum = anchorsNum.filter((n) => !containsNumber(hay, n));
  if (missingNum.length) return { ok: false, reason: `figure(s) not in source: ${missingNum.join(", ")}` };
  const missingName = anchorsName.filter((n) => !containsName(hay, n));
  if (missingName.length) return { ok: false, reason: `name(s) not in source: ${missingName.join(", ")}` };
  return { ok: true, reason: "all figures and names appear in the cited source" };
}

// --- LLM entailment judge ------------------------------------------------------------------

const verdictSchema = z.object({ verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(["supported", "unsupported"]), note: z.string().default("") })) });

const JUDGE_SYSTEM = `You are a strict fact-checking editor for a sports & fitness media brand. For each claim you decide whether it is SUPPORTED.
- A claim about a result, record, time, athlete, team, date or event is "supported" ONLY if the provided source text directly states it. Do not use outside knowledge, do not accept plausible inferences, and mark "unsupported" if the claim adds any specific the source lacks.
- A "general" claim (no source) is "supported" only if it is a widely accepted, uncontroversial piece of general fitness/running information that is NOT individual medical advice, NOT a promise of results and NOT a specific figure.
Respond with ONLY JSON: {"verdicts":[{"id":"c1","verdict":"supported|unsupported","note":"short reason"}]}`;

/**
 * Verifies every claim: deterministic anchors first (cheap, strict), then an LLM entailment judge
 * for the survivors. Fails CLOSED — if the judge can't run, the error propagates (job retries /
 * queue pauses) rather than letting an unchecked claim through.
 */
export async function verifyClaims(deps: Deps, script: Pick<ScriptDoc, "claims" | "sourceAliases">, sources: SourceItem[], template: Template, ctx: { contentId?: string; correlationId?: string }): Promise<ClaimVerdict[]> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const verdicts: ClaimVerdict[] = [];
  const toJudge: Array<{ claim: Claim; source?: SourceItem }> = [];

  for (const claim of script.claims) {
    const source = claim.sourceItemId ? byId.get(claim.sourceItemId) : undefined;
    const det = deterministicCheck(claim, source, template);
    if (!det.ok) verdicts.push({ id: claim.id, verified: false, reason: det.reason, method: "deterministic" });
    else toJudge.push({ claim, source });
  }

  if (toJudge.length > 0) {
    const payload = toJudge.map(({ claim, source }) =>
      claim.kind === "general"
        ? { id: claim.id, kind: "general", claim: claim.text }
        : { id: claim.id, kind: claim.kind, claim: claim.text, source: `${source!.title}. ${source!.summary} ${source!.bodyText}`.slice(0, 1500) },
    );
    const res = await deps.llm.json({
      task: "qa.verify_claims",
      role: "reviewer",
      system: JUDGE_SYSTEM,
      prompt: `Judge each claim:\n${JSON.stringify(payload, null, 1)}`,
      schema: verdictSchema,
      maxTokens: 1200,
      temperature: 0,
      input: { claims: payload },
      contentId: ctx.contentId,
      correlationId: ctx.correlationId,
    });
    const got = new Map(res.verdicts.map((v) => [v.id, v]));
    for (const { claim } of toJudge) {
      const v = got.get(claim.id);
      if (!v) verdicts.push({ id: claim.id, verified: false, reason: "judge returned no verdict (treated as unverified)", method: "llm" });
      else verdicts.push({ id: claim.id, verified: v.verdict === "supported", reason: v.note || v.verdict, method: claim.kind === "general" ? "general" : "llm" });
    }
  }
  return script.claims.map((c) => verdicts.find((v) => v.id === c.id)!);
}

// --- narration audit: statements that bypass the claims list -----------------------------

export interface NarrationAudit {
  /** beat id -> reasons the beat says something that is not covered by a verified claim or source */
  flagged: Map<string, string[]>;
}

const QUOTE_RE = /[“"]([^”"]{6,})[”"]/g;

/**
 * The writer might state a figure/name/quote in a beat without listing it as a claim. Any such
 * figure, name or quotation that isn't in a VERIFIED claim or the content's sources is flagged.
 */
export function auditNarration(beats: Beat[], verifiedClaims: Claim[], sources: SourceItem[]): NarrationAudit {
  const pool = normalizeForMatch([...verifiedClaims.map((c) => `${c.text} ${c.quote ?? ""}`), ...sources.map((s) => sourceText(s))].join(" \n "));
  const flagged = new Map<string, string[]>();
  const add = (id: string, why: string) => flagged.set(id, [...(flagged.get(id) ?? []), why]);
  for (const b of beats) {
    for (const n of extractNumbers(b.text)) if (!containsNumber(pool, n)) add(b.id, `unsourced figure "${n}"`);
    for (const nm of extractNames(b.text)) if (!containsName(pool, nm)) add(b.id, `unsourced name "${nm}"`);
    for (const q of b.text.matchAll(QUOTE_RE)) if (!pool.includes(normalizeForMatch(q[1]!))) add(b.id, `unsourced quotation "${q[1]!.slice(0, 40)}"`);
  }
  return { flagged };
}

/** Removes beats that rely on an unverified claim or fail the narration audit; drops the unverified claims. */
export function applyVerification(script: ScriptDoc, verdicts: ClaimVerdict[], sources: SourceItem[]): ScriptDoc {
  const bad = new Map(verdicts.filter((v) => !v.verified).map((v) => [v.id, v.reason]));
  const goodClaims = script.claims.filter((c) => !bad.has(c.id));
  const removed = [...script.removed];
  let beats = script.beats.filter((b) => {
    const badRef = b.claimIds.find((id) => bad.has(id));
    if (badRef) {
      removed.push({ beatId: b.id, reason: `claim ${badRef}: ${bad.get(badRef)}` });
      return false;
    }
    return true;
  });
  const audit = auditNarration(beats, goodClaims, sources);
  beats = beats.filter((b) => {
    const why = audit.flagged.get(b.id);
    if (why) {
      removed.push({ beatId: b.id, reason: why.join("; ") });
      return false;
    }
    return true;
  });
  const keep = new Set(beats.flatMap((b) => b.claimIds));
  const next: ScriptDoc = { ...script, beats, claims: goodClaims.filter((c) => keep.has(c.id) || script.beats.every((b) => !b.claimIds.includes(c.id))), removed };
  return next;
}

export { narrationOf };
