import { getContent, patchContent, transition, type Content } from "../db/content.js";
import { EVERGREEN_TEMPLATES } from "../ideate/agent.js";
import { getCurrentWeights, lengthBucket, LENGTH_BUCKETS, type LengthBucket } from "../ideate/weights.js";
import { getItemsByIds } from "../ingest/store.js";
import { CITABLE_KINDS, type SourceItem } from "../ingest/types.js";
import { BRAND_VOICE, HOOK_RULES } from "../prompts.js";
import { applyVerification, verifyClaims } from "../qa/factcheck.js";
import type { Deps, JobData } from "../queue/types.js";
import { PLATFORM_NOTES, TEMPLATE_SPECS } from "./templates.js";
import { estimateDurationS, narrationOf, scriptWriterSchema, type Claim, type ScriptDoc } from "./types.js";

const MAX_DURATION_S = 55;
const MIN_BEATS = 3;

const LENGTH_TARGET: Record<LengthBucket, string> = { short: "about 20 seconds (~50 words)", medium: "about 30 seconds (~78 words)", long: "about 42 seconds (~110 words)" };

export interface ScriptPromptInput {
  template: string;
  pillar: string;
  topic: string;
  angle: string;
  hookStyle: string | null;
  sources: Array<{ alias: string; id: string; title: string; summary: string; body: string; kind: string; source: string; citable: boolean }>;
  feedback: string | null;
  lengthTarget: string;
  evergreen: boolean;
}

function buildPrompt(content: Content, sources: SourceItem[], lengthTarget: string, feedback: string | null) {
  const evergreen = EVERGREEN_TEMPLATES.includes(content.template);
  const aliased = sources.map((s, i) => ({
    alias: `S${i + 1}`,
    id: s.id,
    title: s.title,
    summary: s.summary,
    body: s.bodyText.slice(0, 900),
    kind: s.kind,
    source: s.source,
    citable: CITABLE_KINDS.includes(s.kind),
  }));
  const srcBlock = aliased.length
    ? aliased.map((s) => `${s.alias} [${s.source} | ${s.citable ? "FACTUAL SOURCE" : "topic signal only - never cite as a fact"}]: ${s.title}${s.summary ? ` — ${s.summary}` : ""}${s.body && s.body !== s.summary ? `\n   ${s.body}` : ""}`).join("\n")
    : "(no sources - this is an evergreen piece: use only general-interest statements)";
  const spec = TEMPLATE_SPECS[content.template];

  const system = `${BRAND_VOICE}\n\nYou write short-form (vertical video) scripts. ${HOOK_RULES}\nRespond with ONLY JSON.`;
  const prompt = `Write a script for the "${content.template}" template.

Topic: ${content.topic}
Angle: ${(content.idea as any).angle ?? ""}
Preferred hook style: ${content.hookStyle ?? "any"}
Target length: ${lengthTarget}. Hard maximum ${MAX_DURATION_S} seconds spoken (~140 words).

Template structure: ${spec.structure}
Visual block: ${spec.visual}

SOURCES (the ONLY place facts may come from):
${srcBlock}

Rules:
- Every number, name, date, result, record or quotation in a beat MUST appear in the sources above. If the sources don't say it, don't say it.
- List each factual statement as a claim: {"id":"c1","text":"...","source":"S1","kind":"fact|stat|quote"}; for a quote also give "quote": the exact words. Beats list the claims they rely on in claimIds.
- ${evergreen ? 'Because this is an evergreen template, tip/explainer statements may be {"kind":"general","source":null} claims, but they must contain NO numbers and NO proper names, and must not be individual medical, injury, diet-plan or supplement advice.' : 'Do not use kind "general" claims.'}
- Never invent quotes. Never present medical/injury advice. No clickbait the facts can't support.
${PLATFORM_NOTES}
${feedback ? `\nA previous version FAILED review. Fix these problems:\n${feedback}\n` : ""}
JSON shape:
{"title":"","hookStyle":"question|stat|contrast|promise|story|news","beats":[{"id":"b1","text":"voiceover words","onScreen":"short on-screen text","claimIds":["c1"]}],"claims":[{"id":"c1","text":"","source":"S1","kind":"fact","quote":null}],"visual":{"headline":"","stat":null,"statLabel":null,"items":[]},"variants":{"tiktok":{"caption":"","hashtags":[]},"instagram":{"caption":"","hashtags":[]},"youtube":{"title":"","description":"","hashtags":[]}}}
Use between ${MIN_BEATS} and 9 beats.`;
  const input: ScriptPromptInput = { template: content.template, pillar: content.pillar, topic: content.topic, angle: (content.idea as any).angle ?? "", hookStyle: content.hookStyle, sources: aliased, feedback, lengthTarget, evergreen };
  return { system, prompt, input, aliased };
}

/** Drops trailing beats (never the hook) until the spoken estimate fits under the hard cap. */
export function trimToDuration<T extends { beats: ScriptDoc["beats"] }>(s: T, maxS = MAX_DURATION_S): T {
  const beats = [...s.beats];
  while (beats.length > MIN_BEATS && estimateDurationS({ beats }) > maxS) beats.pop();
  return { ...s, beats };
}

export type ScriptOutcome = "scripted" | "skipped" | "regenerating" | "failed";

export async function runScript(deps: Deps, data: JobData): Promise<ScriptOutcome> {
  const { db, cfg, log, llm } = deps;
  if (!data.contentId) throw new Error("script job needs contentId");
  const content = await getContent(db, data.contentId);
  if (!content) throw new Error(`content ${data.contentId} not found`);
  if (content.status !== "idea") {
    log.info({ contentId: content.id, status: content.status }, "script: already past idea, skipping (idempotent)");
    return "skipped";
  }

  const sources = (await getItemsByIds(db, content.sourceItemIds)).sort(
    (a, b) => Number(CITABLE_KINDS.includes(b.kind)) - Number(CITABLE_KINDS.includes(a.kind)) || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
  );
  const weights = (await getCurrentWeights(db)).weights;
  const bucket = [...LENGTH_BUCKETS].sort((a, b) => weights.lengths[b] - weights.lengths[a])[0]!;
  const { system, prompt, input, aliased } = buildPrompt(content, sources, LENGTH_TARGET[bucket], content.qaFeedback);

  const out = await llm.json({
    task: "script.write",
    role: "writer",
    system,
    prompt,
    schema: scriptWriterSchema,
    maxTokens: 3000,
    temperature: 0.6,
    input,
    contentId: content.id,
    correlationId: content.correlationId,
  });

  const aliasToId = Object.fromEntries(aliased.map((s) => [s.alias, s.id]));
  const claims: Claim[] = out.claims.map((c) => ({ ...c, sourceItemId: c.source ? (aliasToId[c.source] ?? null) : null }));
  const claimIds = new Set(claims.map((c) => c.id));
  let doc: ScriptDoc = {
    ...out,
    // references to claims that don't exist can't be verified, so they are dropped, not trusted
    beats: out.beats.map((b) => ({ ...b, claimIds: b.claimIds.filter((id) => claimIds.has(id)) })),
    claims,
    sourceAliases: aliasToId,
    estimatedDurationS: 0,
    removed: [],
    generator: llm.isStub ? "stub" : "live",
  };

  // Pre-filter: verify claims against sources and strip beats that rest on anything unverified.
  const verdicts = await verifyClaims(deps, doc, sources, content.template, { contentId: content.id, correlationId: content.correlationId });
  doc = applyVerification(doc, verdicts, sources);
  doc = trimToDuration(doc);
  doc.estimatedDurationS = estimateDurationS(doc);

  if (doc.beats.length < MIN_BEATS) {
    const reasons = doc.removed.map((r) => `- beat ${r.beatId}: ${r.reason}`).join("\n") || "- too few usable beats";
    const regen = content.regenCount;
    if (regen < cfg.qa.maxRegenerations) {
      const feedback = `The previous draft could not be grounded in the sources, so most of it was removed:\n${reasons}\nWrite a version that sticks strictly to facts present in the sources.`;
      await patchContent(db, content.id, { regen_count: regen + 1, qa_feedback: feedback });
      await deps.enqueue("script", { contentId: content.id, correlationId: content.correlationId, regen: regen + 1 });
      log.warn({ contentId: content.id, correlationId: content.correlationId, regen: regen + 1 }, "script not groundable; regenerating with feedback");
      return "regenerating";
    }
    await transition(db, content.id, "idea", "failed", { error: `Script could not be grounded in sources after ${regen + 1} attempts`, failed_stage: "script" }, { stage: "script", detail: { reasons: doc.removed } });
    await deps.alerter.send({ key: `script_ungroundable:${content.id}`, severity: "warning", title: "Idea dropped: could not be grounded in sources", body: `${content.topic}\n${reasons}` });
    return "failed";
  }

  const moved = await transition(
    db,
    content.id,
    "idea",
    "scripted",
    { script: doc, hook_style: doc.hookStyle, qa_feedback: null },
    { stage: "script", detail: { beats: doc.beats.length, removed: doc.removed.length, estimatedDurationS: doc.estimatedDurationS, bucket: lengthBucket(doc.estimatedDurationS), words: narrationOf(doc).split(/\s+/).length } },
  );
  if (!moved) return "skipped";
  await deps.enqueue("voice", { contentId: content.id, correlationId: content.correlationId, regen: content.regenCount });
  log.info({ contentId: content.id, correlationId: content.correlationId, beats: doc.beats.length, removed: doc.removed.length, durationS: doc.estimatedDurationS }, "script written");
  return "scripted";
}
