import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { runAutonomyAgent } from "../src/autonomy/agent.js";
import { getFastAdapt } from "../src/autonomy/fastAdapt.js";
import { getCapOverrides, setCapOverride } from "../src/safety/capOverrides.js";
import { makeDeps } from "./helpers.js";

const NOW = new Date("2026-11-16T09:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** n content rows landing in [fromDaysAgo, toDaysAgo) of NOW, `held` of them held, the rest published. */
async function seedQaHistory(db: Db, n: number, held: number, fromDaysAgo: number, toDaysAgo: number) {
  for (let i = 0; i < n; i++) {
    const at = new Date(daysAgo(toDaysAgo).getTime() + (i / n) * (daysAgo(fromDaysAgo).getTime() - daysAgo(toDaysAgo).getTime()));
    const status = i < held ? "held" : "published";
    await db.query(
      `INSERT INTO content (id, correlation_id, status, pillar, template, topic, status_changed_at) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'running', 'news_flash', 't', $2)`,
      [status, at.toISOString()],
    );
  }
}

async function seedPublished(db: Db, n: number, perDayDaysAgo: number[]) {
  for (const d of perDayDaysAgo) {
    for (let i = 0; i < n; i++) {
      await db.query(
        `INSERT INTO publications (id, content_id, platform, status, published_at, dry_run) VALUES (gen_random_uuid(), gen_random_uuid(), 'tiktok', 'published', $1, false)`,
        [daysAgo(d).toISOString()],
      );
    }
  }
}

async function seedSpend(db: Db, provider: string, perDayUsd: number, days: number[]) {
  for (const d of days) await db.query(`INSERT INTO spend_ledger (provider, category, usd, at) VALUES ($1,'llm',$2,$3)`, [provider, perDayUsd, daysAgo(d).toISOString()]);
}

describe("runAutonomyAgent", () => {
  let ctxP: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctxP = makeDeps({ now: NOW, env: { DRY_RUN: "false" } });
  });

  it("changes nothing without enough QA history to judge health", async () => {
    const { deps, db } = await ctxP;
    const r = await runAutonomyAgent(deps);
    expect(r).toMatchObject({ capsRaised: [], fastAdaptEnabled: false });
    expect(r.notes[0]).toMatch(/not enough recent QA history/);
    expect(await getCapOverrides(db)).toEqual({});
  });

  it("enables fast-adapt once the hold-rate has been stable over two windows", async () => {
    const { deps, db } = await ctxP;
    await seedQaHistory(db, 10, 1, 0, 7); // recent: 10%
    await seedQaHistory(db, 10, 1, 7, 14); // baseline: 10%, same
    const r = await runAutonomyAgent(deps);
    expect(r.fastAdaptEnabled).toBe(true);
    expect((await getFastAdapt(db)).reason).toMatch(/stable/);
  });

  it("turns fast-adapt back off the moment the hold-rate regresses, and leaves caps alone", async () => {
    const { deps, db } = await ctxP;
    await setCapOverride(db, undefined, deps.cfg, { maxPostsPerDay: 5 }, "pre-set so a raise would otherwise be possible");
    await seedQaHistory(db, 10, 1, 7, 14); // baseline: 10% held
    await seedQaHistory(db, 10, 6, 0, 7); // recent: 60% held - a real regression
    const r = await runAutonomyAgent(deps);
    expect(r.fastAdaptEnabled).toBe(false);
    expect(r.capsRaised).toEqual([]); // the same regression blocks cap raises too
    expect(r.notes[0]).toMatch(/hold-rate rose/);
  });

  it("raises a cap that has stayed well under its headroom, but never past the ceiling, and reports it", async () => {
    const { deps, db } = await ctxP;
    await setCapOverride(db, undefined, deps.cfg, { maxPostsPerDay: 5, provider: "anthropic", daily: 1 }, "starting point below the ceiling (9 / $3)", undefined, daysAgo(10)); // outside the cooldown
    await seedQaHistory(db, 10, 1, 0, 7);
    await seedQaHistory(db, 10, 1, 7, 14);
    await seedPublished(db, 1, [1, 2, 3]); // ~0.43/day average, well under 70% of a cap of 5
    await seedSpend(db, "anthropic", 0.2, [1, 2, 3, 4, 5]); // 0.14/day average, well under 70% of $1

    const r = await runAutonomyAgent(deps);
    expect(r.capsRaised).toEqual(expect.arrayContaining([expect.stringContaining("maxPostsPerDay 5->6"), expect.stringContaining("anthropic.daily $1->$1.1")]));
    const o = await getCapOverrides(db);
    expect(o.maxPostsPerDay).toBe(6);
    expect(o.providers?.anthropic?.daily).toBe(1.1);
  });

  it("never raises a cap again within the 7-day cooldown, even if health is perfect", async () => {
    const { deps, db } = await ctxP;
    await setCapOverride(db, undefined, deps.cfg, { maxPostsPerDay: 5 }, "starting point", undefined, NOW); // set "now" - inside the cooldown window
    await seedQaHistory(db, 10, 1, 0, 7);
    await seedQaHistory(db, 10, 1, 7, 14);
    await seedPublished(db, 1, [1, 2, 3]);
    const r = await runAutonomyAgent(deps);
    expect(r.capsRaised).toEqual([]);
  });

  it("does not raise a cap that already has no headroom under its ceiling", async () => {
    const { deps, db } = await ctxP; // no override: the live cap already equals the config ceiling
    await seedQaHistory(db, 10, 1, 0, 7);
    await seedQaHistory(db, 10, 1, 7, 14);
    await seedPublished(db, 5, [1, 2, 3, 4, 5, 6, 7]); // way over 70% of the ceiling's 9/day
    const r = await runAutonomyAgent(deps);
    expect(r.capsRaised).toEqual([]);
  });

  it("folds an unresolved token-refresh failure into its notes, without sending a second alert", async () => {
    const { deps, db } = await ctxP;
    await deps.alerter.send({ key: "token_refresh_failed:tiktok", severity: "critical", title: "tiktok token refresh FAILED", throttleMs: 0 });
    const r = await runAutonomyAgent(deps);
    expect(r.notes.some((n) => n.includes("tiktok") && n.includes("reconnect"))).toBe(true);
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM alerts_log WHERE key LIKE 'token_refresh_failed:%'`)).rows[0].n).toBe(1);
  });

  it("will not raise a cap after a spend cap was hit in the last 7 days, even with perfect QA health", async () => {
    const { deps, db } = await ctxP;
    await setCapOverride(db, undefined, deps.cfg, { maxPostsPerDay: 5 }, "starting point");
    await seedQaHistory(db, 10, 1, 0, 7);
    await seedQaHistory(db, 10, 1, 7, 14);
    await seedPublished(db, 1, [1, 2, 3]);
    await deps.alerter.send({ key: "spend_cap:anthropic:daily", severity: "critical", title: "cap hit", throttleMs: 0 });
    const r = await runAutonomyAgent(deps);
    expect(r.capsRaised).toEqual([]);
    expect(r.notes[0]).toMatch(/spend cap was hit/);
  });
});
