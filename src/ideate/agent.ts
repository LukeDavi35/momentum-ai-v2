import { z } from "zod";
import { PILLARS, TEMPLATES, type AppConfig, type Pillar, type Template } from "../config/index.js";
import type { Content, IdeaScores } from "../db/content.js";
import { createContent } from "../db/content.js";
import { listRecentItems } from "../ingest/store.js";
import { CITABLE_KINDS } from "../ingest/types.js";
import { BRAND_VOICE } from "../prompts.js";
import type { Deps, JobData } from "../queue/types.js";
import { clusterItems, thresholds, type Cluster } from "./cluster.js";
import { similarity, type Embedding } from "./embeddings.js";
import { getCurrentWeights, HOOK_STYLES, type HookStyle, type Weights } from "./weights.js";

/** Templates whose claims are general-interest and need no source (but may not contain figures/names — see qa/factcheck). */
export const EVERGREEN_TEMPLATES: Template[] = ["training_tip", "quick_explainer"];
const PIPELINE_STATUSES = ["idea", "scripted", "voiced", "rendered", "qa_passed", "qa_failed", "scheduled"];

const proposalSchema = z.object({
  ideas: z
    .array(
      z.object({
        clusterId: z.string(),
        template: z.enum(TEMPLATES),
        topic: z.string().min(3).max(160),
        angle: z.string().max(500),
        hookStyle: z.enum(HOOK_STYLES),
        templateFit: z.number().min(0).max(10),
      }),
    )
    .max(40),
});
export type Proposal = z.infer<typeof proposalSchema>["ideas"][number];

export interface Candidate {
  cluster: Cluster | { id: string; pillar: Pillar; evergreen: true; velocity: number; items: []; citable: [] };
  template: Template;
  topic: string;
  angle: string;
  hookStyle: HookStyle;
  templateFit: number;
  embedding: Embedding;
  scores: IdeaScores;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function scoreIdea(
  w: Weights,
  p: { velocity: number; templateFit: number; novelty: number; template: Template; pillar: Pillar; hookStyle: HookStyle },
): IdeaScores {
  // learned multipliers are the engagement prior: 1.0 each => 0.5
  const engagement = clamp(0.5 * w.templates[p.template] * w.pillars[p.pillar] * w.hookStyles[p.hookStyle], 0, 1);
  const total =
    w.scoring.velocity * p.velocity + w.scoring.templateFit * (p.templateFit / 10) + w.scoring.novelty * p.novelty + w.scoring.engagement * engagement;
  return { velocity: p.velocity, templateFit: p.templateFit / 10, novelty: p.novelty, engagement, total };
}

/** Share of each pillar we WANT: configured weight x learned multiplier, normalised. */
export function targetPillarShares(cfg: AppConfig, w: Weights): Record<Pillar, number> {
  const raw = Object.fromEntries(PILLARS.map((p) => [p, (cfg.pillars.pillars[p]?.weight ?? 0) * w.pillars[p]])) as Record<Pillar, number>;
  const sum = PILLARS.reduce((s, p) => s + raw[p], 0) || 1;
  return Object.fromEntries(PILLARS.map((p) => [p, raw[p] / sum])) as Record<Pillar, number>;
}

/**
 * Greedy pick of `n` ideas maximising score x pillar-deficit boost, so pillars that are
 * under-represented in the last 7 days (versus target shares) get priority. Pure — unit tested.
 */
export function selectWithRotation(cands: Candidate[], n: number, recentCounts: Record<Pillar, number>, target: Record<Pillar, number>): Candidate[] {
  const picked: Candidate[] = [];
  const counts = { ...recentCounts };
  const pool = [...cands];
  while (picked.length < n && pool.length > 0) {
    const total = PILLARS.reduce((s, p) => s + counts[p], 0);
    let bestIdx = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const actual = total === 0 ? 0 : counts[c.cluster.pillar] / total;
      const t = target[c.cluster.pillar] || 0.0001;
      const deficit = clamp((t - actual) / t, -0.5, 1); // +1 = totally missing, -0.5 = heavily over-represented
      const val = c.scores.total * (1 + 0.6 * deficit);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    });
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen!);
    counts[chosen!.cluster.pillar] += 1;
  }
  return picked;
}

function proposalPrompt(cfg: AppConfig, clusters: Cluster[], n: number, winners: string[] = []): { system: string; prompt: string; input: unknown } {
  const templates = Object.entries(cfg.pillars.templates).map(([k, v]) => `- ${k}: ${v.description} (fits: ${v.pillars.join(", ")})`).join("\n");
  const list = clusters
    .map((c) => {
      const lines = c.items.slice(0, 3).map((i) => `   • [${i.source}${CITABLE_KINDS.includes(i.kind) ? "" : ", signal-only"}] ${i.title}${i.summary ? ` — ${i.summary.slice(0, 160)}` : ""}`);
      return `${c.id} | pillar=${c.pillar} | factual_sources=${c.citable.length} | velocity=${c.velocity.toFixed(2)}\n${lines.join("\n")}`;
    })
    .join("\n\n");
  const winnersBlock = winners.length ? `\nOur own recent top performers (what our audience responded to - take inspiration from the angle/format, never repeat the topic):\n${winners.map((w) => `- ${w}`).join("\n")}\n` : "";
  const system = `${BRAND_VOICE}\n\nYou are the ideation editor. Choose the strongest short-video ideas from current stories. Respond with ONLY JSON.`;
  const prompt = `Templates:\n${templates}\n${winnersBlock}\nCurrent story clusters:\n${list}\n\nPropose up to ${Math.max(n * 3, 6)} ideas as JSON:\n{"ideas":[{"clusterId":"c1","template":"news_flash","topic":"short working title","angle":"one sentence on the angle","hookStyle":"question|stat|contrast|promise|story|news","templateFit":0-10}]}\nRules: each idea must use a clusterId above. Templates other than training_tip/quick_explainer need a cluster with factual_sources >= 1 ("signal-only" items are topic hints, never facts). You may add up to 2 evergreen training_tip/quick_explainer ideas with clusterId "evergreen:fitness" or "evergreen:running" when the news is thin. Prefer fresh, verifiable, high-velocity stories; do not propose near-duplicates of each other.`;
  return {
    system,
    prompt,
    input: { n, winners, clusters: clusters.map((c) => ({ id: c.id, pillar: c.pillar, headline: c.headline, citable: c.citable.length, velocity: c.velocity })) },
  };
}

export interface IdeationResult {
  created: string[];
  considered: number;
  skippedReason?: string;
}

export async function runIdeation(deps: Deps, data: JobData): Promise<IdeationResult> {
  const { cfg, db, log, llm, embedder } = deps;
  const now = deps.now();

  const inv = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM content WHERE status = ANY($1::text[])`, [PIPELINE_STATUSES]);
  const inventory = Number(inv.rows[0]?.n ?? 0);
  const room = cfg.schedule.plan.inventoryTargetPieces - inventory;
  if (room <= 0) {
    log.info({ inventory }, "ideation skipped: pipeline inventory already at target");
    return { created: [], considered: 0, skippedReason: "inventory_full" };
  }
  const want = Math.min(cfg.schedule.ideate.keepTopN, room);

  const weightsV = await getCurrentWeights(db);
  // our own best recent posts (ingested by the 'internal' source) guide the LLM toward what works
  const winnerRows = await db.query<{ title: string; summary: string }>(
    `SELECT title, summary FROM source_items WHERE kind = 'internal' AND fetched_at > $1 ORDER BY COALESCE((metrics->>'perf')::float8, 0) DESC LIMIT 5`,
    [new Date(now.getTime() - 14 * 86400_000).toISOString()],
  );
  const winners = winnerRows.rows.map((r) => r.title);
  const items = (await listRecentItems(db, 48, now)).filter((i) => i.kind !== "internal");
  if (items.length === 0) return { created: [], considered: 0, skippedReason: "no_source_items" };

  const clusters = clusterItems(items, now)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, cfg.schedule.ideate.candidatesPerCycle + 3);
  if (clusters.length === 0) return { created: [], considered: 0, skippedReason: "no_clusters" };

  const { system, prompt, input } = proposalPrompt(cfg, clusters, want, winners);
  const proposal = await llm.json({
    task: "ideate.propose",
    role: "writer",
    system,
    prompt,
    schema: proposalSchema,
    maxTokens: 2500,
    temperature: 0.7,
    input,
    correlationId: data.correlationId,
  });

  // validate proposals against the real clusters + template rules
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const valid: Array<{ p: Proposal; cluster: Candidate["cluster"] }> = [];
  for (const p of proposal.ideas) {
    const evergreenMatch = p.clusterId.match(/^evergreen:(.+)$/);
    if (evergreenMatch) {
      const pillar = evergreenMatch[1] as Pillar;
      if (!PILLARS.includes(pillar) || !EVERGREEN_TEMPLATES.includes(p.template)) continue;
      valid.push({ p, cluster: { id: p.clusterId, pillar, evergreen: true, velocity: 0.2, items: [], citable: [] } });
      continue;
    }
    const cluster = byId.get(p.clusterId);
    if (!cluster) continue;
    if (!EVERGREEN_TEMPLATES.includes(p.template) && cluster.citable.length === 0) continue; // factual templates need a citable source
    if (!cfg.pillars.templates[p.template].pillars.includes(cluster.pillar)) continue;
    valid.push({ p, cluster });
  }

  // embed ideas, then novelty/dedupe against the last 30 days and against each other
  const embs = valid.length ? await embedder.embed(valid.map(({ p }) => `${p.topic}. ${p.angle}`)) : [];
  const past = await db.query<{ embedding: Embedding | null }>(
    `SELECT embedding FROM content WHERE created_at > $1 AND status <> 'failed' AND embedding IS NOT NULL`,
    [new Date(now.getTime() - 30 * 86400_000).toISOString()],
  );
  const pastEmbs = past.rows.map((r) => r.embedding).filter((e): e is Embedding => !!e);

  const cands: Candidate[] = [];
  let duplicates = 0;
  valid.forEach(({ p, cluster }, i) => {
    const emb = embs[i]!;
    const dupThr = thresholds(emb.model).duplicate;
    const maxPast = Math.max(0, ...pastEmbs.map((e) => similarity(emb, e)));
    const maxPeer = Math.max(0, ...cands.map((c) => similarity(emb, c.embedding)));
    if (maxPast >= dupThr || maxPeer >= dupThr) {
      duplicates++;
      return;
    }
    const scores = scoreIdea(weightsV.weights, {
      velocity: cluster.velocity,
      templateFit: p.templateFit,
      novelty: clamp(1 - maxPast, 0, 1),
      template: p.template,
      pillar: cluster.pillar,
      hookStyle: p.hookStyle,
    });
    cands.push({ cluster, template: p.template, topic: p.topic, angle: p.angle, hookStyle: p.hookStyle, templateFit: p.templateFit, embedding: emb, scores });
  });
  cands.sort((a, b) => b.scores.total - a.scores.total);

  const recent = await db.query<{ pillar: Pillar; n: number }>(
    `SELECT pillar, COUNT(*)::int AS n FROM content WHERE created_at > $1 AND status <> 'failed' GROUP BY pillar`,
    [new Date(now.getTime() - 7 * 86400_000).toISOString()],
  );
  const recentCounts = Object.fromEntries(PILLARS.map((p) => [p, 0])) as Record<Pillar, number>;
  for (const r of recent.rows) recentCounts[r.pillar] = Number(r.n);

  const chosen = selectWithRotation(cands, want, recentCounts, targetPillarShares(cfg, weightsV.weights));

  const created: string[] = [];
  for (const c of chosen) {
    const cluster = c.cluster as Cluster;
    const evergreen = "evergreen" in c.cluster;
    const sourceIds = evergreen ? [] : [...cluster.citable, ...cluster.items.filter((i) => !cluster.citable.includes(i))].slice(0, 8).map((i) => i.id);
    const row: Content = await createContent(db, {
      pillar: c.cluster.pillar,
      template: c.template,
      topic: c.topic,
      hookStyle: c.hookStyle,
      score: c.scores.total,
      sourceItemIds: sourceIds,
      embedding: c.embedding,
      idea: { angle: c.angle, clusterId: c.cluster.id, evergreen, scores: c.scores, weightsVersion: weightsV.version, llm: llm.isStub ? "stub" : "live" },
    });
    created.push(row.id);
    await deps.enqueue("script", { contentId: row.id, correlationId: row.correlationId, regen: 0 });
    log.info({ contentId: row.id, correlationId: row.correlationId, template: c.template, pillar: c.cluster.pillar, score: c.scores.total }, "idea created");
  }
  log.info({ considered: cands.length, duplicates, created: created.length }, "ideation cycle done");
  return { created, considered: cands.length };
}
