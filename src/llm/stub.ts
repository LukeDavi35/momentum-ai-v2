import { createHash } from "node:crypto";
import type { CompleteRequest, CompleteResponse, LlmProvider } from "./types.js";
import { normalizeForMatch } from "../ingest/text.js";
import type { ScriptPromptInput } from "../script/agent.js";

/**
 * Deterministic stand-in for the LLM, used when no ANTHROPIC_API_KEY is configured (dry-run / CI).
 * It is NOT a language model: it builds scripts extractively from real source sentences and
 * judges claims by substring match. Everything it produces is tagged generator="stub" so a demo
 * can never be mistaken for real model output. It exists so the full pipeline — including the
 * real fact-check, QA and rendering code — can run end to end with no credentials.
 */
export class StubProvider implements LlmProvider {
  readonly name = "stub";
  readonly billable = false;

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const out = this.dispatch(req);
    const text = JSON.stringify(out);
    return { text, inputTokens: Math.ceil((req.prompt.length + req.system.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }

  private dispatch(req: CompleteRequest): unknown {
    switch (req.task) {
      case "ideate.propose":
        return stubIdeas(req.input as any);
      case "script.write":
        return stubScript(req.input as ScriptPromptInput);
      case "qa.verify_claims":
        return stubVerify(req.input as any);
      case "qa.review":
        return stubReview(req.input as any);
      case "learning.report":
        return { summary: "Stub summary: see the tables below for the numbers." };
      default:
        throw new Error(`StubProvider has no handler for task "${req.task}"`);
    }
  }
}

const h = (s: string): number => createHash("md5").update(s).digest().readUInt16BE(0);

// ------------------------------------------------------------------ ideate

function stubIdeas(input: { n: number; clusters: Array<{ id: string; pillar: string; headline: string; citable: number; velocity: number }> }) {
  const ideas: any[] = [];
  for (const c of input.clusters.slice(0, 8)) {
    if (c.citable === 0) continue;
    const hasNumber = /\d/.test(c.headline);
    const template = c.pillar === "track_and_field" ? (hasNumber ? "stat_spotlight" : "race_recap") : c.pillar === "running" ? "race_recap" : hasNumber ? "stat_spotlight" : "news_flash";
    ideas.push({
      clusterId: c.id,
      template,
      topic: c.headline.slice(0, 120),
      angle: "What happened and why it matters right now",
      hookStyle: hasNumber ? "stat" : "news",
      templateFit: 6 + (h(c.headline) % 4),
    });
  }
  ideas.push(
    { clusterId: "evergreen:running", template: "training_tip", topic: "Three habits for easier running", angle: "general-interest running habits", hookStyle: "promise", templateFit: 7 },
    { clusterId: "evergreen:fitness", template: "quick_explainer", topic: "What a warm-up is actually for", angle: "plain-language explainer", hookStyle: "question", templateFit: 7 },
  );
  return { ideas };
}

// ------------------------------------------------------------------ script

const clean = (s: string): string => s.replace(/…$/, "").replace(/\s+/g, " ").trim();
const sentences = (s: string): string[] =>
  clean(s)
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.split(/\s+/).length >= 5);
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const capWords = (s: string, n: number): string => words(s).slice(0, n).join(" ");

const EVERGREEN: Record<string, string[]> = {
  training_tip: [
    "Build up your weekly running gradually so your body can adapt.",
    "Keep most of your runs at an easy, conversational effort.",
    "Mix in rest days, because recovery is where training sticks.",
  ],
  quick_explainer: [
    "A warm-up gradually raises your heart rate and gets your muscles ready to move.",
    "It also lets you rehearse the movements you are about to do, at a lower intensity.",
    "That is why many people feel smoother and more prepared once they start the main session.",
  ],
};

const HASHTAGS: Record<string, string[]> = {
  running: ["running", "runnersofinstagram", "marathon", "runningtips"],
  fitness: ["fitness", "workout", "gym", "healthyhabits"],
  track_and_field: ["trackandfield", "athletics", "sprint", "worldathletics"],
  sports_news: ["sports", "sportsnews", "breakingnews", "athletes"],
};

function stubScript(input: ScriptPromptInput) {
  const evergreen = input.evergreen;
  const citable = input.sources.filter((s) => s.citable);
  const beats: any[] = [];
  const claims: any[] = [];
  let b = 0;
  let c = 0;
  const addFact = (text: string, alias: string, kind: "fact" | "stat" = "fact", onScreen?: string) => {
    const t = clean(text);
    c++;
    b++;
    claims.push({ id: `c${c}`, text: t, source: alias, kind });
    beats.push({ id: `b${b}`, text: t, onScreen: onScreen ?? capWords(t, 8), claimIds: [`c${c}`] });
  };
  const addPlain = (text: string, onScreen = "") => {
    b++;
    beats.push({ id: `b${b}`, text, onScreen, claimIds: [] });
  };

  let statValue: string | null = null;
  const items: string[] = [];

  if (evergreen) {
    const tips = EVERGREEN[input.template] ?? EVERGREEN.quick_explainer!;
    addPlain(input.template === "training_tip" ? "Three quick tips to make running feel easier." : "Ever wondered what a warm-up is really for?", capWords(input.topic, 6));
    for (const tip of tips) {
      c++;
      b++;
      claims.push({ id: `c${c}`, text: tip, source: null, kind: "general" });
      beats.push({ id: `b${b}`, text: tip, onScreen: capWords(tip, 6), claimIds: [`c${c}`] });
      items.push(capWords(tip, 6));
    }
    addPlain("This is general information, not personal advice. Follow Momentum for more.", "General info only");
  } else {
    const lead = citable[0];
    if (lead) {
      const hook = capWords(clean(lead.title), 14);
      addFact(hook, lead.alias, "fact", capWords(hook, 6));
      addPlain("Here is what you need to know.", "The key facts");
      const pool = citable.flatMap((s) => sentences(`${s.summary} ${s.body}`).map((t) => ({ t, alias: s.alias })));
      const seen = new Set<string>([normalizeForMatch(hook)]);
      for (const { t, alias } of pool) {
        const k = normalizeForMatch(t);
        if (seen.has(k) || [...seen].some((x) => x.includes(k) || k.includes(x))) continue;
        seen.add(k);
        addFact(t, alias);
        items.push(capWords(t, 6));
        if (!statValue) statValue = t.match(/\d+(?:[:.,]\d+)*/)?.[0] ?? null;
        if (items.length >= 4) break;
      }
      statValue ??= lead.title.match(/\d+(?:[:.,]\d+)*/)?.[0] ?? null;
    }
    // pad so even thin sources reach a watchable length without adding any facts
    const fillers = ["Stay with us for the details.", "It is a story that is moving quickly in the sport.", "We will keep an eye on what comes next."];
    while (words(beats.map((x) => x.text).join(" ")).length < 40 && fillers.length) addPlain(fillers.shift()!);
    addPlain("Follow Momentum for more sports updates.", "Follow for more");
  }

  const pillarTags = HASHTAGS[(input as any).pillar ?? "sports_news"] ?? HASHTAGS.sports_news!;
  const hook = beats[0]?.text ?? input.topic;
  return {
    title: capWords(input.topic, 12).slice(0, 95),
    hookStyle: (["question", "stat", "contrast", "promise", "story", "news"].includes(input.hookStyle ?? "") ? input.hookStyle : "news") as string,
    beats,
    claims,
    visual: {
      headline: capWords(input.topic, 8),
      stat: statValue && statValue.length <= 24 ? statValue : null,
      statLabel: statValue ? capWords(claims[0]?.text ?? input.topic, 8) : null,
      items: items.slice(0, 4),
    },
    variants: {
      tiktok: { caption: capWords(hook, 22), hashtags: pillarTags.slice(0, 4) },
      instagram: { caption: capWords(hook, 30), hashtags: pillarTags.slice(0, 5) },
      youtube: { title: capWords(input.topic, 14).slice(0, 90), description: `${capWords(hook, 30)}`, hashtags: pillarTags.slice(0, 3) },
    },
  };
}

// ------------------------------------------------------------------ verify / review

function stubVerify(input: { claims: Array<{ id: string; kind: string; claim: string; source?: string }> }) {
  return {
    verdicts: input.claims.map((c) => {
      if (c.kind === "general") return { id: c.id, verdict: "supported", note: "stub: general statement" };
      const ok = c.source ? normalizeForMatch(c.source).includes(normalizeForMatch(c.claim).replace(/…$/, "")) : false;
      return { id: c.id, verdict: ok ? "supported" : "unsupported", note: ok ? "stub: claim text found in source" : "stub: claim text not found in source" };
    }),
  };
}

function stubReview(input: { hookWords: number; unverifiedClaims: number; flaggedBeats: number; policyViolations: string[]; beats: number; estimatedDurationS: number }) {
  const feedback: string[] = [];
  const accuracy = input.unverifiedClaims === 0 && input.flaggedBeats === 0 ? 9 : 4;
  if (accuracy < 7) feedback.push("Remove or correct statements that are not supported by the sources.");
  const hook = input.hookWords > 0 && input.hookWords <= 14 ? 8 : 5;
  if (hook < 7) feedback.push("Tighten the opening beat to a punchy line of 14 words or fewer.");
  const policy = input.policyViolations.length === 0 ? 9 : 3;
  if (policy < 7) feedback.push(`Resolve policy issues: ${input.policyViolations.join("; ")}`);
  const clarity = input.beats >= 3 ? 8 : 5;
  if (clarity < 7) feedback.push("Give the piece at least three clear beats.");
  return { scores: { accuracy, brand_voice: 8, hook_strength: hook, clarity, policy_safety: policy }, feedback };
}
