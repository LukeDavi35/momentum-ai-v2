import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContent, getContent } from "../../src/db/content.js";
import { getSetting } from "../../src/db/settings.js";
import { createRedis } from "../../src/queue/connection.js";
import { monitor } from "../../src/queue/maintenance.js";
import { createQueues, makeEnqueue, type QueueSet } from "../../src/queue/queues.js";
import { jobIdFor, type JobData } from "../../src/queue/types.js";
import { PAUSED_KEY, startWorkers, type Handler, type WorkerHandle } from "../../src/queue/worker.js";
import { KillSwitchActive } from "../../src/safety/killswitch.js";
import { SpendCapExceeded } from "../../src/safety/spend.js";
import { makeDeps } from "../helpers.js";
import { REDIS_TEST_URL, redisUp, waitFor } from "./redis.js";

const up = await redisUp();
const CID = "00000000-0000-4000-8000-000000000009";
const FAST_RETRY = { attempts: 3, backoff: { type: "fixed" as const, delay: 40 } };

describe.skipIf(!up)("queue backbone (real Redis + BullMQ)", () => {
  let redis: Redis;
  let qs: QueueSet;
  let handle: WorkerHandle | undefined;

  beforeAll(() => {
    redis = createRedis(REDIS_TEST_URL);
  });
  beforeEach(async () => {
    await redis.flushdb();
    qs = createQueues(redis);
  });
  afterEach(async () => {
    await handle?.close(5000);
    handle = undefined;
    await qs.close();
  });
  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  const run = async (handlers: Partial<Record<string, Handler>>, only: string[] = ["script"]) => {
    const ctx = await makeDeps();
    ctx.deps.enqueue = makeEnqueue(qs);
    const all = new Proxy({} as Record<string, Handler>, { get: (_t, k: string) => handlers[k] ?? (async () => "noop") });
    handle = startWorkers(ctx.deps, qs, redis, all as any, async () => "noop", only as any);
    return ctx;
  };

  it("enqueue is idempotent: the same logical step added twice is one job", async () => {
    const enq = makeEnqueue(qs);
    const data: JobData = { contentId: "c1", correlationId: CID, regen: 0 };
    await enq("script", data);
    await enq("script", data);
    await enq("script", { ...data, regen: 1 }); // a different regeneration round IS a different job
    expect(await qs.queues.script.getJobCountByTypes("waiting", "delayed")).toBe(2);
    expect(jobIdFor("script", data)).toBe("script__c1__r0");
  });

  it("retries a failing job and succeeds without dead-lettering", async () => {
    let calls = 0;
    const ctx = await run({
      script: async () => {
        if (++calls < 3) throw new Error(`transient ${calls}`);
        return "ok";
      },
    });
    await qs.queues.script.add("script", { correlationId: CID, contentId: undefined }, { jobId: "r1", ...FAST_RETRY });
    await waitFor(async () => (await qs.queues.script.getJob("r1"))?.finishedOn);
    expect(calls).toBe(3);
    expect((await qs.queues.script.getJob("r1"))!.attemptsMade).toBe(3);
    expect((await ctx.db.query(`SELECT 1 FROM dead_letters`)).rowCount).toBe(0);
  });

  it("dead-letters after the final attempt: DLQ entry + dead_letters row + content failed + critical alert", async () => {
    const ctx = await run({
      script: async () => {
        throw new Error("always broken");
      },
    });
    const c = await createContent(ctx.db, { pillar: "running", template: "quick_explainer", topic: "t", idea: {}, sourceItemIds: [], correlationId: CID });
    await qs.queues.script.add("script", { contentId: c.id, correlationId: CID, regen: 0 }, { jobId: "d1", ...FAST_RETRY });
    await waitFor(async () => (await ctx.db.query(`SELECT 1 FROM dead_letters`)).rowCount > 0);
    const dl = (await ctx.db.query(`SELECT * FROM dead_letters`)).rows[0];
    expect(dl).toMatchObject({ queue: "script", job_id: "d1", attempts: 3, content_id: c.id });
    expect(dl.error).toContain("always broken");
    await waitFor(async () => (await getContent(ctx.db, c.id))!.status === "failed");
    expect(await qs.dlq.getJobCountByTypes("waiting")).toBe(1);
    expect((await ctx.db.query(`SELECT severity FROM alerts_log WHERE key = 'dlq:script'`)).rows[0].severity).toBe("critical");
  });

  it("KILL SWITCH: a publish job that hits it is DELAYED (not failed, no retry consumed, nothing dead-lettered)", async () => {
    const ctx = await run(
      {
        publish: async () => {
          throw new KillSwitchActive("dashboard", "drill");
        },
      },
      ["publish"],
    );
    await qs.queues.publish.add("publish", { kind: "publish", correlationId: CID }, { jobId: "k1", ...FAST_RETRY });
    const job = await waitFor(async () => {
      const j = await qs.queues.publish.getJob("k1");
      return j && (await j.getState()) === "delayed" ? j : false;
    });
    expect(job.attemptsMade).toBe(0);
    expect((await ctx.db.query(`SELECT 1 FROM dead_letters`)).rowCount).toBe(0);
  });

  it("SPEND CAP: pauses the affected queues, records why, delays the job, and the monitor resumes them when the cap clears", async () => {
    let capped = true;
    const ctx = await run(
      {
        script: async () => {
          throw new SpendCapExceeded("anthropic", "daily", 3.1, 3);
        },
      },
      ["script"],
    );
    await qs.queues.script.add("script", { correlationId: CID }, { jobId: "s1", ...FAST_RETRY });
    await waitFor(async () => qs.queues.script.isPaused());
    expect(await qs.queues.ideate.isPaused()).toBe(true);
    expect(await qs.queues.qa.isPaused()).toBe(true);
    expect(await qs.queues.render.isPaused()).toBe(false); // only the Anthropic-dependent queues stop
    const paused = (await getSetting<Record<string, { provider: string }>>(ctx.db, PAUSED_KEY))!;
    expect(Object.keys(paused).sort()).toEqual(["ideate", "qa", "script"]);
    expect((await qs.queues.script.getJob("s1"))!.attemptsMade).toBe(0);
    expect((await ctx.db.query(`SELECT severity FROM alerts_log WHERE key = 'spend_cap:anthropic:daily'`)).rows[0].severity).toBe("critical");

    // still capped -> monitor leaves them paused
    await ctx.db.query(`INSERT INTO spend_ledger (provider, category, usd, at) VALUES ('anthropic','x',99,$1)`, [ctx.deps.now().toISOString()]);
    const resumed: string[] = [];
    const counts = async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    expect((await monitor(ctx.deps, counts, async (q) => void resumed.push(q))).resumed).toEqual([]);
    // cap cleared -> resumed
    await ctx.db.query(`DELETE FROM spend_ledger`);
    capped = false;
    const res = await monitor(ctx.deps, counts, async (q) => qs.queues[q].resume());
    expect(res.resumed.sort()).toEqual(["ideate", "qa", "script"]);
    expect(await qs.queues.script.isPaused()).toBe(false);
    expect(capped).toBe(false);
    expect(await getSetting(ctx.db, PAUSED_KEY)).toEqual({});
  });

  it("monitor alerts on a queue backlog over the threshold", async () => {
    const ctx = await makeDeps();
    ctx.deps.cfg.limits.queueBacklogAlert = 5;
    const res = await monitor(ctx.deps, async (q) => ({ waiting: q === "render" ? 12 : 0, active: 0, delayed: 0, failed: 0 }), async () => {});
    expect(res.backlogAlerts).toEqual(["render"]);
    expect((await ctx.db.query(`SELECT 1 FROM alerts_log WHERE key = 'backlog:render'`)).rowCount).toBe(1);
  });

  it("graceful shutdown waits for an in-flight job to finish instead of dropping it", async () => {
    let finished = false;
    await run({
      script: async () => {
        await new Promise((r) => setTimeout(r, 600));
        finished = true;
        return "done";
      },
    });
    await qs.queues.script.add("script", { correlationId: CID }, { jobId: "g1" });
    await waitFor(async () => (await qs.queues.script.getActiveCount()) === 1);
    await handle!.close(10_000); // SIGTERM path
    handle = undefined;
    expect(finished).toBe(true);
    expect((await qs.queues.script.getJob("g1"))!.finishedOn).toBeTruthy();
  });
});
