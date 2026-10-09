import { describe, expect, it } from "vitest";
import { PILLARS } from "../src/config/index.js";
import { clusterItems, computeVelocity, inferPillar, thresholds } from "../src/ideate/cluster.js";
import { LocalHashEmbedder, cosine, similarity } from "../src/ideate/embeddings.js";
import { runIdeation, scoreIdea, selectWithRotation, targetPillarShares, type Candidate } from "../src/ideate/agent.js";
import { defaultWeights, getCurrentWeights, listWeightVersions, rollbackWeights, saveWeights } from "../src/ideate/weights.js";
import { createContent } from "../src/db/content.js";
import { storeItems } from "../src/ingest/store.js";
import type { RawItem } from "../src/ingest/types.js";
import { makeDeps, testConfig } from "./helpers.js";

const CID = "00000000-0000-4000-8000-000000000001";
const emb = new LocalHashEmbedder();
const NOW = new Date("2026-10-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

describe("embeddings", () => {
  it("scores near-duplicate headlines far above unrelated ones", async () => {
    const [a, b, c] = await emb.embed([
      "Faith Kipyegon breaks 1500m world record in Paris",
      "Kipyegon smashes 1500m world record at Paris meeting",
      "Manchester City boss defends league titles",
    ]);
    expect(similarity(a!, b!)).toBeGreaterThan(0.5);
    expect(similarity(a!, c!)).toBeLessThan(0.25);
  });
  it("never compares vectors from different models", () => {
    expect(similarity({ model: "x", vector: [1, 0] }, { model: "y", vector: [1, 0] })).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
  it("is deterministic and unit-length", async () => {
    const [a] = await emb.embed(["hello world"]);
    const [b] = await emb.embed(["hello world"]);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!.vector)).toBeCloseTo(1, 5);
  });
});

describe("velocity + clustering", () => {
  const base = { sources: ["a"], trendTraffic: 0, redditScore: 0 };
  it("is higher for fresh, multi-source, corroborated stories and decays with age", () => {
    const hot = computeVelocity({ ...base, sources: ["a", "b", "c"], recent6h: 3, recent24h: 6, newestAgeHours: 0.5, trendTraffic: 200000, redditScore: 5000 });
    const cold = computeVelocity({ ...base, recent6h: 0, recent24h: 1, newestAgeHours: 30 });
    expect(hot).toBeGreaterThan(0.7);
    expect(cold).toBeLessThan(0.1);
    expect(computeVelocity({ ...base, recent6h: 3, recent24h: 3, newestAgeHours: 0 })).toBeGreaterThan(computeVelocity({ ...base, recent6h: 3, recent24h: 3, newestAgeHours: 48 }));
    expect(hot).toBeLessThanOrEqual(1);
  });
  it("infers pillar from hints first, then keywords, else sports_news", () => {
    expect(inferPillar("anything", ["running", "running", "fitness"])).toBe("running");
    expect(inferPillar("Diamond League sprint final", [null])).toBe("track_and_field");
    expect(inferPillar("Parkrun 5k PB tips", [])).toBe("running");
    expect(inferPillar("Tennis star wins", [])).toBe("sports_news");
  });
  it("groups the same story from different outlets and keeps unrelated stories apart", async () => {
    const mk = async (source: string, title: string, h: number, kind: RawItem["kind"] = "news"): Promise<any> => {
      const [e] = await emb.embed([title]);
      return { id: `${source}${title}`, source, kind, pillar: null, url: null, title, summary: "", bodyText: "", publishedAt: hoursAgo(h), fetchedAt: hoursAgo(h), metrics: {}, embedding: e };
    };
    const items = [
      await mk("bbc", "Kipyegon breaks 1500m world record in Paris", 1),
      await mk("guardian", "Kipyegon smashes 1500m world record at Paris meeting", 2),
      await mk("espn", "Cowboys lose to Buccaneers in third quarter collapse", 3),
    ];
    const clusters = clusterItems(items, NOW);
    expect(clusters).toHaveLength(2);
    const kip = clusters.find((c) => c.headline.includes("Kipyegon"))!;
    expect(kip.items).toHaveLength(2);
    expect(kip.sources.sort()).toEqual(["bbc", "guardian"]);
    expect(kip.velocity).toBeGreaterThan(clusters.find((c) => c.headline.includes("Cowboys"))!.velocity);
    expect(thresholds("openai-x").cluster).toBeGreaterThan(thresholds("local-hash-256").cluster);
  });
});

describe("scoring + rotation", () => {
  const w = defaultWeights();
  it("default scoring weights sum to 1", () => {
    expect(Object.values(w.scoring).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it("scores higher for velocity/fit/novelty and respects learned multipliers", () => {
    const base = { velocity: 0.5, templateFit: 6, novelty: 0.5, template: "news_flash" as const, pillar: "running" as const, hookStyle: "stat" as const };
    const a = scoreIdea(w, base);
    expect(scoreIdea(w, { ...base, velocity: 0.9 }).total).toBeGreaterThan(a.total);
    const boosted = { ...w, templates: { ...w.templates, news_flash: 1.8 } };
    expect(scoreIdea(boosted, base).engagement).toBeGreaterThan(a.engagement);
    expect(scoreIdea({ ...w, templates: { ...w.templates, news_flash: 50 } }, base).engagement).toBe(1); // clamped
  });
  const cand = (pillar: any, total: number): Candidate => ({ cluster: { id: pillar + total, pillar, evergreen: true, velocity: 0, items: [], citable: [] }, template: "quick_explainer", topic: "t", angle: "a", hookStyle: "stat", templateFit: 5, embedding: { model: "m", vector: [] }, scores: { velocity: 0, templateFit: 0, novelty: 0, engagement: 0, total } });
  it("rotation favours an under-represented pillar over a slightly higher-scoring over-represented one", () => {
    const target = targetPillarShares(testConfig(), w);
    const recent = { running: 10, fitness: 0, track_and_field: 0, sports_news: 0 };
    const picked = selectWithRotation([cand("running", 0.62), cand("fitness", 0.55)], 1, recent, target);
    expect(picked[0]!.cluster.pillar).toBe("fitness");
  });
  it("still picks the best candidate when pillars are balanced, and never returns more than asked", () => {
    const target = targetPillarShares(testConfig(), w);
    const zero = { running: 0, fitness: 0, track_and_field: 0, sports_news: 0 };
    const picked = selectWithRotation([cand("running", 0.4), cand("running", 0.9), cand("fitness", 0.3)], 2, zero, target);
    expect(picked).toHaveLength(2);
    expect(picked.map((p) => p.scores.total)).toContain(0.9);
    expect(targetPillarShares(testConfig(), w).running).toBeCloseTo(0.3, 5);
    expect(PILLARS.reduce((s, p) => s + targetPillarShares(testConfig(), w)[p], 0)).toBeCloseTo(1, 10);
  });
});

describe("weight versions", () => {
  it("seeds defaults, appends versions, and rolls back by appending (never deleting)", async () => {
    const { db } = await makeDeps();
    const v1 = await getCurrentWeights(db);
    expect(v1.version).toBe(1);
    const changed = { ...v1.weights, templates: { ...v1.weights.templates, news_flash: 1.4 } };
    const v2 = await saveWeights(db, changed, "weekly update", "auto");
    expect((await getCurrentWeights(db)).weights.templates.news_flash).toBe(1.4);
    const v3 = await rollbackWeights(db, 1);
    expect(v3).toBe(v2 + 1);
    expect((await getCurrentWeights(db)).weights.templates.news_flash).toBe(1);
    const versions = await listWeightVersions(db);
    expect(versions.map((v) => v.kind)).toEqual(["rollback", "auto", "initial"]);
    await expect(rollbackWeights(db, 999)).rejects.toThrow(/No weight version/);
  });
});

describe("runIdeation", () => {
  const items = (): RawItem[] => [
    { source: "bbc", kind: "news", pillar: "track_and_field", title: "Kipyegon breaks 1500m world record in Paris", summary: "Faith Kipyegon ran 3:49.04.", url: "https://x/1", publishedAt: hoursAgo(1) },
    { source: "guardian", kind: "news", pillar: "track_and_field", title: "Kipyegon smashes 1500m world record at Paris meeting", summary: "A record night.", url: "https://x/2", publishedAt: hoursAgo(2) },
    { source: "espn", kind: "news", pillar: "sports_news", title: "Cowboys lose to Buccaneers after third quarter collapse", summary: "Big swing.", url: "https://x/3", publishedAt: hoursAgo(3) },
    { source: "reddit/r/running", kind: "reddit", pillar: "running", title: "Anyone else dreading their first marathon?", summary: "", url: "https://r/1", publishedAt: hoursAgo(2), metrics: { score: 300, comments: 80 } },
  ];
  const reply = (req: any) => {
    const ids: string[] = req.input.clusters.map((c: any) => c.id);
    const byHeadline = (s: string) => req.input.clusters.find((c: any) => c.headline.includes(s))?.id ?? ids[0];
    return {
      ideas: [
        { clusterId: byHeadline("Kipyegon"), template: "stat_spotlight", topic: "Kipyegon's record time", angle: "the number", hookStyle: "stat", templateFit: 9 },
        { clusterId: byHeadline("Cowboys"), template: "news_flash", topic: "Cowboys collapse", angle: "third quarter", hookStyle: "news", templateFit: 6 },
        { clusterId: byHeadline("marathon"), template: "news_flash", topic: "Reddit-only factual idea", angle: "must be rejected", hookStyle: "news", templateFit: 9 },
        { clusterId: "nope", template: "news_flash", topic: "unknown cluster", angle: "x", hookStyle: "news", templateFit: 9 },
        { clusterId: "evergreen:running", template: "training_tip", topic: "First marathon pacing basics", angle: "general tips", hookStyle: "promise", templateFit: 8 },
        { clusterId: "evergreen:running", template: "news_flash", topic: "evergreen with factual template", angle: "must be rejected", hookStyle: "news", templateFit: 9 },
      ],
    };
  };

  it("creates content from valid ideas only, enqueues script jobs with correlation ids, rejects unsourced factual ideas", async () => {
    const { deps, db, enqueued } = await makeDeps({ reply, billable: true });
    deps.cfg.schedule.ideate.keepTopN = 3;
    await storeItems(db, deps.embedder, items(), NOW);
    const res = await runIdeation(deps, { correlationId: CID });
    const rows = (await db.query(`SELECT topic, template, pillar, status, correlation_id, source_item_ids FROM content ORDER BY topic`)).rows;
    expect(res.created).toHaveLength(rows.length);
    const topics = rows.map((r) => r.topic);
    expect(topics).toContain("Kipyegon's record time");
    expect(topics).not.toContain("Reddit-only factual idea"); // factual template, no citable source
    expect(topics).not.toContain("unknown cluster");
    expect(topics).not.toContain("evergreen with factual template");
    expect(rows.every((r) => r.status === "idea")).toBe(true);
    expect(enqueued.every((e) => e.queue === "script" && e.data.regen === 0 && e.data.correlationId && e.data.contentId)).toBe(true);
    const kip = rows.find((r) => r.topic.startsWith("Kipyegon"))!;
    expect(kip.source_item_ids).toHaveLength(2); // both outlets' items attached as sources
    expect((await db.query(`SELECT idea FROM content LIMIT 1`)).rows[0].idea.llm).toBe("live");
    // a billable provider's call is recorded in the spend ledger
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM spend_ledger WHERE provider = 'anthropic' AND category = 'ideate.propose'`)).rows[0].n).toBe(1);
  });

  it("de-dupes against content from the last 30 days", async () => {
    const { deps, db } = await makeDeps({ reply });
    deps.cfg.schedule.ideate.keepTopN = 3;
    await storeItems(db, deps.embedder, items(), NOW);
    const [e] = await deps.embedder.embed(["Kipyegon's record time. the number"]);
    await createContent(db, { pillar: "track_and_field", template: "stat_spotlight", topic: "Kipyegon's record time", idea: {}, sourceItemIds: [], embedding: e! });
    await db.query(`UPDATE content SET status = 'published'`);
    const res = await runIdeation(deps, { correlationId: CID });
    const topics = (await db.query(`SELECT topic FROM content WHERE status = 'idea'`)).rows.map((r) => r.topic);
    expect(topics).not.toContain("Kipyegon's record time");
    expect(res.created.length).toBeGreaterThan(0);
  });

  it("does nothing when the pipeline inventory is already at target (spend control)", async () => {
    const { deps, db, provider } = await makeDeps({ reply });
    await storeItems(db, deps.embedder, items(), NOW);
    for (let i = 0; i < deps.cfg.schedule.plan.inventoryTargetPieces; i++) {
      await createContent(db, { pillar: "running", template: "quick_explainer", topic: `t${i}`, idea: {}, sourceItemIds: [] });
    }
    const res = await runIdeation(deps, { correlationId: CID });
    expect(res).toMatchObject({ created: [], skippedReason: "inventory_full" });
    expect(provider.calls).toHaveLength(0); // no LLM spend at all
  });

  it("skips quietly when there are no source items", async () => {
    const { deps } = await makeDeps({ reply });
    expect((await runIdeation(deps, { correlationId: CID })).skippedReason).toBe("no_source_items");
  });
});
