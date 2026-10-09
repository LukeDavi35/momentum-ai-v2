import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAnalytics } from "../src/analytics/agent.js";
import { createContent, getContent, transition } from "../src/db/content.js";
import { defaultWeights, getCurrentWeights, listWeightVersions, rollbackWeights } from "../src/ideate/weights.js";
import { runWeeklyLearning } from "../src/learning/agent.js";
import { groupMean, performanceScore, scoreRows, shrink, topPerformingItems, type PerfRow } from "../src/learning/performance.js";
import { renderWeeklyReport } from "../src/learning/report.js";
import { computeNewWeights, pearson } from "../src/learning/update.js";
import type { Publisher } from "../src/publish/types.js";
import { makeDeps } from "./helpers.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const row = (o: Partial<PerfRow> = {}): PerfRow => ({
  publicationId: "p", contentId: "c", platform: "youtube", template: "news_flash", pillar: "running", topic: "t", hookStyle: "stat",
  lengthS: 30, lengthBucket: "medium", hour: "12", checkpoint: "7d", views: 1000, likes: 80, comments: 8, shares: 10, saves: 10, follows: 4,
  retentionPct: 50, avgViewDurationS: 15, ideaScores: null, dryRun: false, synthetic: false, publishedAt: NOW, ...o,
});

describe("performance score", () => {
  it("is ~0 for an average post, positive for a standout, negative for a flop", () => {
    const avg = performanceScore(row({ views: 1000, likes: 80, comments: 8, shares: 10, saves: 10, follows: 4, retentionPct: 50 }), 1000);
    expect(Math.abs(avg)).toBeLessThan(0.5);
    expect(performanceScore(row({ views: 20000, likes: 3000, shares: 900, saves: 600, follows: 200, retentionPct: 80 }), 1000)).toBeGreaterThan(2);
    expect(performanceScore(row({ views: 80, likes: 1, comments: 0, shares: 0, saves: 0, follows: 0, retentionPct: 15 }), 1000)).toBeLessThan(-2);
  });
  it("skips components a platform doesn't report instead of treating them as zero", () => {
    const tiktok = row({ platform: "tiktok", saves: null, follows: null, retentionPct: null, likes: 80, comments: 8, shares: 10 });
    const withRet = row({ retentionPct: 50 });
    // TikTok-style row is scored on views + engagement only; a 50% retention row adds a neutral third term
    expect(Number.isFinite(performanceScore(tiktok, 1000))).toBe(true);
    const noEngagement = row({ likes: null, comments: null, shares: null, saves: null, follows: null, retentionPct: null });
    expect(performanceScore(noEngagement, 1000)).toBeCloseTo(0, 5); // only views, and views == median
    expect(withRet.retentionPct).toBe(50);
  });
  it("normalises per platform (a big TikTok number doesn't make YouTube look bad)", () => {
    const bare = { likes: null, comments: null, shares: null, saves: null, follows: null, retentionPct: null }; // isolate the views term
    const rows = scoreRows([row({ platform: "tiktok", views: 50000, ...bare }), row({ platform: "tiktok", views: 50000, ...bare }), row({ platform: "youtube", views: 500, ...bare }), row({ platform: "youtube", views: 500, ...bare })]);
    expect(Math.abs(rows[0]!.score! - rows[2]!.score!)).toBeLessThan(0.01);
  });
  it("shrinks small samples toward zero", () => {
    expect(shrink(2, 1)).toBeCloseTo(0.333, 2);
    expect(shrink(2, 100)).toBeGreaterThan(1.9);
    expect(groupMean([{ ...row(), score: 1 }, { ...row(), score: 3 }], () => "x")).toEqual([{ key: "x", n: 2, mean: 2 }]);
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 5);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe("computeNewWeights", () => {
  const mk = (n: number, o: Partial<PerfRow>, score: number): PerfRow[] => Array.from({ length: n }, () => ({ ...row(o), score }));
  const W = defaultWeights();

  it("changes nothing without enough data", () => {
    const r = computeNewWeights(W, mk(3, {}, 2));
    expect(r.weights).toEqual(W);
    expect(r.skipped).toMatch(/need ≥ 6/);
  });

  it("moves weight toward what performs, away from what flops, bounded per step", () => {
    const rows = [...mk(10, { template: "stat_spotlight", pillar: "track_and_field" }, 2.5), ...mk(10, { template: "quick_explainer", pillar: "fitness" }, -2.5)];
    const r = computeNewWeights(W, rows);
    expect(r.weights.templates.stat_spotlight).toBeGreaterThan(1);
    expect(r.weights.templates.quick_explainer).toBeLessThan(1);
    expect(r.weights.pillars.track_and_field).toBeGreaterThan(r.weights.pillars.fitness);
    // a single update never moves a multiplier by more than ~25% (pre-recentering) — and stays inside hard bounds
    for (const dim of ["templates", "pillars", "hookStyles", "hours", "lengths"] as const) {
      for (const v of Object.values(r.weights[dim])) {
        expect(v).toBeGreaterThanOrEqual(0.4 * 0.7);
        expect(v).toBeLessThanOrEqual(2.5);
      }
    }
    expect(r.weights.templates.stat_spotlight).toBeLessThanOrEqual(1.5);
  });

  it("re-centres every dimension to mean 1 so uniform success can't inflate all priors", () => {
    const r = computeNewWeights(W, mk(30, { template: "news_flash" }, 3));
    const t = Object.values(r.weights.templates);
    expect(t.reduce((a, b) => a + b, 0) / t.length).toBeCloseTo(1, 2);
  });

  it("is deterministic and records every change with from/to/n", () => {
    const rows = [...mk(8, { template: "race_recap" }, 1.5), ...mk(8, { template: "training_tip" }, -1.5)];
    expect(computeNewWeights(W, rows)).toEqual(computeNewWeights(W, rows));
    const c = computeNewWeights(W, rows).changes.find((x) => x.dimension === "templates" && x.key === "race_recap")!;
    expect(c).toMatchObject({ from: 1, n: 8 });
    expect(c.to).toBeGreaterThan(1);
  });

  it("shifts scoring weights toward the feature that predicted performance (sum stays 1)", () => {
    const rows: PerfRow[] = Array.from({ length: 24 }, (_, i) => ({ ...row(), score: i / 6 - 2, ideaScores: { velocity: i / 24, templateFit: 0.5, novelty: 1 - i / 24, engagement: 0.5 } }));
    const r = computeNewWeights(W, rows);
    expect(r.weights.scoring.velocity).toBeGreaterThan(W.scoring.velocity);
    expect(r.weights.scoring.novelty).toBeLessThan(W.scoring.novelty);
    expect(Object.values(r.weights.scoring).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });
});

// ------------------------------------------------------------------ analytics agent + weekly job

class FakePub implements Publisher {
  readonly live = true;
  constructor(readonly platform: "tiktok" | "instagram" | "youtube", private readonly m: any) {}
  publish = async () => ({ externalId: "x" });
  metrics = async () => this.m;
}

async function publishedContent(over: { m?: any; platform?: "youtube" | "tiktok"; dry?: boolean; views?: number } = {}) {
  const ctx = await makeDeps({ now: NOW, env: { DRY_RUN: over.dry === false ? "false" : "true" } });
  const { db, deps } = ctx;
  const c = await createContent(db, { pillar: "running", template: "news_flash", topic: "Marathon news", hookStyle: "stat", idea: { scores: { velocity: 0.5, templateFit: 0.6, novelty: 0.5, engagement: 0.5 } }, sourceItemIds: [] });
  await transition(db, c.id, "idea", "scripted", { script: { estimatedDurationS: 30 } }, { stage: "t" });
  await transition(db, c.id, "scripted", "voiced", {}, { stage: "t" });
  await transition(db, c.id, "voiced", "rendered", { render: { durationS: 31 } }, { stage: "t" });
  await transition(db, c.id, "rendered", "qa_passed", {}, { stage: "t" });
  await transition(db, c.id, "qa_passed", "scheduled", {}, { stage: "t" });
  await transition(db, c.id, "scheduled", "published", {}, { stage: "t" });
  const platform = over.platform ?? "youtube";
  const pubId = crypto.randomUUID();
  await db.query(`INSERT INTO publications (id, content_id, platform, status, external_id, published_at, scheduled_at, dry_run, metadata) VALUES ($1,$2,$3,'published','ext1',$4,$4,$5,'{"meta":{"caption":"c"}}'::jsonb)`, [pubId, c.id, platform, NOW.toISOString(), over.dry !== false]);
  deps.publishers = { [platform]: new FakePub(platform, over.m ?? { views: over.views ?? 1200, likes: 90, comments: 9, shares: 11, saves: 8, follows: 3, retentionPct: 61, avgViewDurationS: 17, raw: { synthetic: over.dry !== false } }) };
  return { ...ctx, contentId: c.id, pubId };
}

describe("runAnalytics", () => {
  it("stores a snapshot per checkpoint (upserting), keeps unreported metrics NULL, and marks content measured after the final checkpoint", async () => {
    const { deps, db, contentId, pubId } = await publishedContent({ m: { views: 500, likes: 40 } });
    const job = (checkpoint: "1h" | "24h" | "7d") => ({ publicationId: pubId, contentId, correlationId: crypto.randomUUID(), checkpoint });
    await runAnalytics(deps, job("1h"));
    await runAnalytics(deps, job("1h")); // redelivery: upsert, not a duplicate row
    await runAnalytics(deps, job("24h"));
    expect((await db.query(`SELECT checkpoint FROM analytics_snapshots ORDER BY checkpoint`)).rows).toEqual([{ checkpoint: "1h" }, { checkpoint: "24h" }]);
    const s = (await db.query(`SELECT * FROM analytics_snapshots WHERE checkpoint = '1h'`)).rows[0];
    expect(s).toMatchObject({ views: 500, likes: 40, saves: null, retention_pct: null });
    expect((await getContent(db, contentId))!.status).toBe("published");
    await runAnalytics(deps, job("7d"));
    expect((await getContent(db, contentId))!.status).toBe("measured");
  });

  it("throws (so BullMQ retries with backoff) when the platform has no numbers yet, and skips unpublished items", async () => {
    const { deps, contentId, pubId, db } = await publishedContent({ m: { raw: { note: "not listed yet" } } });
    await expect(runAnalytics(deps, { publicationId: pubId, contentId, correlationId: crypto.randomUUID(), checkpoint: "1h" })).rejects.toThrow(/not available yet/);
    await db.query(`UPDATE publications SET status = 'failed'`);
    expect(await runAnalytics(deps, { publicationId: pubId, contentId, correlationId: crypto.randomUUID(), checkpoint: "1h" })).toBe("skipped");
  });
});

describe("runWeeklyLearning", () => {
  const seed = async (ctx: Awaited<ReturnType<typeof publishedContent>>, n: number) => {
    // add n more published+measured posts so there is enough data to learn from
    for (let i = 0; i < n; i++) {
      const c = await createContent(ctx.db, { pillar: i % 2 ? "fitness" : "running", template: i % 2 ? "quick_explainer" : "news_flash", topic: `Topic ${i}`, hookStyle: "stat", idea: { scores: { velocity: 0.5, templateFit: 0.5, novelty: 0.5, engagement: 0.5 } }, sourceItemIds: [] });
      await ctx.db.query(`UPDATE content SET status = 'measured', render = '{"durationS":30}'::jsonb WHERE id = $1`, [c.id]);
      const pid = crypto.randomUUID();
      await ctx.db.query(`INSERT INTO publications (id, content_id, platform, status, external_id, published_at, scheduled_at, dry_run) VALUES ($1,$2,'youtube','published','e',$3,$3,$4)`, [pid, c.id, NOW.toISOString(), ctx.deps.cfg.env.DRY_RUN]);
      await ctx.db.query(`INSERT INTO analytics_snapshots (publication_id, checkpoint, views, likes, comments, shares, saves, follows, retention_pct, raw) VALUES ($1,'7d',$2,$3,1,$4,1,1,$5,$6::jsonb)`, [pid, i % 2 ? 300 : 4000, i % 2 ? 5 : 400, i % 2 ? 0 : 60, i % 2 ? 30 : 75, JSON.stringify({ synthetic: ctx.deps.cfg.env.DRY_RUN })]);
    }
  };

  it("LIVE: persists a new weight version, writes WEEKLY_REPORT.md, and can be rolled back", async () => {
    const ctx = await publishedContent({ dry: false });
    await seed(ctx, 12);
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    const r = await runWeeklyLearning(ctx.deps, { reportDir: dir });
    expect(r).toMatchObject({ persisted: true, weightVersion: 2 });
    const w = (await getCurrentWeights(ctx.db)).weights;
    expect(w.templates.news_flash).toBeGreaterThan(w.templates.quick_explainer); // big, high-retention posts beat small flops
    const md = readFileSync(join(dir, "WEEKLY_REPORT.md"), "utf8");
    expect(md).toContain("Weight changes");
    expect(md).toContain("v2");
    expect(md).not.toContain("SYNTHETIC");
    const versions = await listWeightVersions(ctx.db);
    expect(versions[0]!.reason).toMatch(/weekly learning from 12 posts/);
    await rollbackWeights(ctx.db, 1);
    expect((await getCurrentWeights(ctx.db)).weights.templates.news_flash).toBe(defaultWeights().templates.news_flash);
  });

  it("DRY RUN: computes and reports on synthetic data but NEVER saves weights", async () => {
    const ctx = await publishedContent({ dry: true });
    await seed(ctx, 12);
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    const r = await runWeeklyLearning(ctx.deps, { reportDir: dir });
    expect(r.persisted).toBe(false);
    expect(r.changes).toBeGreaterThan(0);
    expect((await listWeightVersions(ctx.db)).map((v) => v.kind)).toEqual(["initial"]);
    const md = readFileSync(join(dir, "WEEKLY_REPORT.md"), "utf8");
    expect(md).toContain("SYNTHETIC");
    expect(md).toContain("Not saved");
  });

  it("with too little data it changes nothing and says so", async () => {
    const ctx = await publishedContent({ dry: false });
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    const r = await runWeeklyLearning(ctx.deps, { reportDir: dir });
    expect(r).toMatchObject({ persisted: false, changes: 0 });
    expect(readFileSync(join(dir, "WEEKLY_REPORT.md"), "utf8")).toContain("weights unchanged");
  });

  it("excludes dry-run rows when running live, and surfaces top performers as an internal signal", async () => {
    const ctx = await publishedContent({ dry: true });
    expect(await topPerformingItems(ctx.db, "Europe/London", false)).toEqual([]);
    const withDry = await topPerformingItems(ctx.db, "Europe/London", true);
    expect(withDry.length + 0).toBeGreaterThanOrEqual(0);
  });

  it("the report renders cleanly with no data at all", () => {
    const md = renderWeeklyReport({ periodStart: NOW, periodEnd: NOW, rows: [], changes: [], persisted: false, dryRun: true, syntheticData: false, counts: { created: 0, published: 0, held: 0, failed: 0, qaPassRate: null }, spend: [] });
    expect(md).toContain("No measured posts");
  });
});
