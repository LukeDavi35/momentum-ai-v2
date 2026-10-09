import { PLATFORMS, type Platform } from "../config/index.js";
import { getContent, transition, type Content } from "../db/content.js";
import { getItemsByIds } from "../ingest/store.js";
import { buildPlatformMetadata, type PlatformMetadata } from "../publish/metadata.js";
import type { Deps, JobData } from "../queue/types.js";
import type { CaptionCue } from "../render/captions.js";
import type { ScriptDoc } from "../script/types.js";
import { wordCount } from "../script/types.js";
import type { VoiceDoc } from "../voice/agent.js";
import { auditNarration, verifyClaims, type ClaimVerdict } from "./factcheck.js";
import { checkPolicy, type PolicyViolation } from "./policy.js";
import { belowThreshold, reviewScript, SCORE_KEYS, type Review } from "./reviewer.js";
import { runTechnicalChecks, type Check } from "./technical.js";

export interface QaFailure {
  kind: "factual" | "technical" | "policy" | "review";
  reason: string;
}

export interface QaDoc {
  passed: boolean;
  attempt: number;
  minScore: number;
  scores: Review["scores"] | null;
  failures: QaFailure[];
  reviewerFeedback: string[];
  checks: { technical: Check[]; policy: PolicyViolation[]; verdicts: ClaimVerdict[]; flagged: Array<{ beatId: string; reasons: string[] }> };
  reviewerSkipped: boolean;
  at: string;
}

export type QaOutcome = "passed" | "regenerating" | "rerendering" | "held" | "skipped";

export const enabledPlatforms = (deps: Deps): Platform[] => PLATFORMS.filter((p) => deps.cfg.schedule.platforms[p].enabled);

export async function runQa(deps: Deps, data: JobData): Promise<QaOutcome> {
  const { db, cfg, log } = deps;
  if (!data.contentId) throw new Error("qa job needs contentId");
  const content = await getContent(db, data.contentId);
  if (!content) throw new Error(`content ${data.contentId} not found`);
  if (content.status !== "rendered") {
    log.info({ contentId: content.id, status: content.status }, "qa: not in rendered, skipping (idempotent)");
    return "skipped";
  }
  const script = content.script as unknown as ScriptDoc;
  const voice = content.voice as unknown as VoiceDoc;
  const render = content.render as any;
  const sources = await getItemsByIds(db, content.sourceItemIds);
  const failures: QaFailure[] = [];

  // 1. factual — re-verified from scratch on the FINAL script (the script-stage pre-filter is not trusted)
  const verdicts = await verifyClaims(deps, script, sources, content.template, { contentId: content.id, correlationId: content.correlationId });
  for (const v of verdicts.filter((x) => !x.verified)) failures.push({ kind: "factual", reason: `claim ${v.id} unverified: ${v.reason}` });
  const verified = script.claims.filter((c) => verdicts.find((v) => v.id === c.id)?.verified);
  const audit = auditNarration(script.beats, verified, sources);
  const flagged = [...audit.flagged.entries()].map(([beatId, reasons]) => ({ beatId, reasons }));
  for (const f of flagged) failures.push({ kind: "factual", reason: `beat ${f.beatId} states something not in the sources: ${f.reasons.join("; ")}` });
  if (script.claims.length === 0 && !["training_tip", "quick_explainer"].includes(content.template)) failures.push({ kind: "factual", reason: "a factual template has no claims to verify" });

  // 2. policy (incl. AI-disclosure + per-platform limits)
  const enabled = enabledPlatforms(deps);
  const metadata: Partial<Record<Platform, PlatformMetadata>> = {};
  for (const p of enabled) metadata[p] = buildPlatformMetadata(p, content, script, sources);
  const policy = checkPolicy(script, metadata, enabled);
  for (const v of policy.violations) failures.push({ kind: "policy", reason: `${v.rule} in ${v.where}: ${v.excerpt}` });

  // 3. technical
  const hookWords = wordCount(script.beats[0]?.text ?? "");
  let technical: Check[] = [];
  try {
    technical = await runTechnicalChecks({ cfg, videoPath: render.videoPath, captionsPath: render.captionsPath, cues: render.cues as CaptionCue[], voice, hookWords, runner: deps.runner });
  } catch (e) {
    technical = [{ name: "analysis", ok: false, message: `could not analyse the video: ${(e as Error).message.slice(0, 300)}` }];
  }
  for (const c of technical.filter((x) => !x.ok)) failures.push({ kind: "technical", reason: `${c.name}: ${c.message}${c.expected ? ` (expected ${c.expected})` : ""}` });

  // 4. independent LLM reviewer — only worth paying for when nothing deterministic already failed
  let review: Review | null = null;
  const deterministicOk = failures.length === 0;
  if (deterministicOk) {
    review = await reviewScript(deps, { content, script, verdicts, flaggedBeats: flagged.length, policyViolations: [], hookWords });
    for (const { key, value } of belowThreshold(review.scores, cfg.qa.minScore)) failures.push({ kind: "review", reason: `${key} scored ${value}/${cfg.qa.minScore} minimum` });
  }

  const passed = failures.length === 0;
  const doc: QaDoc = {
    passed,
    attempt: content.regenCount,
    minScore: cfg.qa.minScore,
    scores: review?.scores ?? null,
    failures,
    reviewerFeedback: review?.feedback ?? [],
    checks: { technical, policy: policy.violations, verdicts, flagged },
    reviewerSkipped: !deterministicOk,
    at: deps.now().toISOString(),
  };
  await db.query(`INSERT INTO qa_results (content_id, attempt, passed, scores, reasons, detail) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`, [
    content.id,
    content.regenCount,
    passed,
    JSON.stringify(review?.scores ?? {}),
    JSON.stringify(failures),
    JSON.stringify({ reviewerFeedback: doc.reviewerFeedback, reviewerSkipped: doc.reviewerSkipped }),
  ]);

  if (passed) {
    const moved = await transition(db, content.id, "rendered", "qa_passed", { qa: doc }, { stage: "qa", detail: { scores: doc.scores } });
    if (!moved) return "skipped";
    await deps.enqueue("publish", { contentId: content.id, correlationId: content.correlationId, kind: "schedule", regen: content.regenCount });
    log.info({ contentId: content.id, correlationId: content.correlationId, scores: doc.scores }, "QA passed");
    return "passed";
  }
  return handleFailure(deps, content, doc);
}

async function handleFailure(deps: Deps, content: Content, doc: QaDoc): Promise<QaOutcome> {
  const { db, cfg, log } = deps;
  const failed = await transition(db, content.id, "rendered", "qa_failed", { qa: doc }, { stage: "qa", detail: { failures: doc.failures.length } });
  if (!failed) return "skipped";
  await consecutiveFailureAlert(deps);

  const regen = content.regenCount;
  const feedback = [...doc.failures.map((f) => `[${f.kind}] ${f.reason}`), ...doc.reviewerFeedback.map((f) => `[reviewer] ${f}`)].join("\n");
  const technicalOnly = doc.failures.every((f) => f.kind === "technical");

  if (regen >= cfg.qa.maxRegenerations) {
    await transition(db, content.id, "qa_failed", "held", { error: `QA failed after ${regen + 1} attempts`, failed_stage: "qa", qa_feedback: feedback }, { stage: "qa", detail: { reason: "regeneration budget exhausted" } });
    await deps.alerter.send({ key: `held:${content.id}`, severity: "warning", title: "Content HELD after repeated QA failures (will not publish)", body: `${content.topic}\n${feedback}`.slice(0, 1500) });
    log.warn({ contentId: content.id, correlationId: content.correlationId, failures: doc.failures.length }, "QA failed; content held");
    return "held";
  }

  if (technicalOnly) {
    // the script is fine — only the audio/video came out wrong, so redo voice + render, keep the script
    await transition(db, content.id, "qa_failed", "scripted", { regen_count: regen + 1, voice: null, render: null, qa_feedback: null }, { stage: "qa", detail: { retry: "voice+render", regen: regen + 1 } });
    await deps.enqueue("voice", { contentId: content.id, correlationId: content.correlationId, regen: regen + 1 });
    log.warn({ contentId: content.id, correlationId: content.correlationId, regen: regen + 1 }, "QA technical failure; re-voicing and re-rendering");
    return "rerendering";
  }
  await transition(db, content.id, "qa_failed", "idea", { regen_count: regen + 1, qa_feedback: feedback }, { stage: "qa", detail: { retry: "script", regen: regen + 1 } });
  await deps.enqueue("script", { contentId: content.id, correlationId: content.correlationId, regen: regen + 1 });
  log.warn({ contentId: content.id, correlationId: content.correlationId, regen: regen + 1 }, "QA content failure; regenerating script with reviewer feedback");
  return "regenerating";
}

/** 3+ failed QA runs in a row usually means something systemic (bad prompt, source outage, broken render), not bad luck. */
async function consecutiveFailureAlert(deps: Deps): Promise<void> {
  const n = deps.cfg.qa.consecutiveFailureAlert;
  const res = await deps.db.query<{ passed: boolean }>(`SELECT passed FROM qa_results ORDER BY id DESC LIMIT $1`, [n]);
  if (res.rows.length >= n && res.rows.every((r) => !r.passed)) {
    await deps.alerter.send({ key: "qa_consecutive_failures", severity: "critical", title: `${n} consecutive QA failures`, body: "Nothing has passed QA in the last runs; check the dashboard for reasons.", throttleMs: 6 * 3600_000 });
  }
}

export { SCORE_KEYS };
