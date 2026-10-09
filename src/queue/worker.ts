import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { failContent } from "../db/content.js";
import { getSetting, setSetting } from "../db/settings.js";
import { newCorrelationId } from "../logger.js";
import { KillSwitchActive } from "../safety/killswitch.js";
import { SpendCapExceeded } from "../safety/spend.js";
import { MAINTENANCE_QUEUE, QUEUE_NAMES, type QueueName } from "./names.js";
import type { QueueSet } from "./queues.js";
import type { Deps, JobData } from "./types.js";

export type Handler = (deps: Deps, data: JobData) => Promise<unknown>;

/** Never retried: retrying cannot help (e.g. the content row doesn't exist). Surfaces as UnrecoverableError. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** Conservative for an 8 GB laptop / small VPS: rendering is CPU+RAM heavy so it runs one at a time; publishing is serialised so caps can't race. */
export const CONCURRENCY: Record<QueueName | typeof MAINTENANCE_QUEUE, number> = {
  ingest: 2,
  ideate: 1,
  script: 2,
  voice: 2,
  render: 1,
  qa: 2,
  publish: 1,
  analytics: 3,
  maintenance: 1,
};

const KILL_SWITCH_RECHECK_MS = 5 * 60_000;
const SPEND_RECHECK_MS = 10 * 60_000;

export interface PausedQueues {
  [queue: string]: { provider: string; since: string; reason: string };
}
export const PAUSED_KEY = "paused_queues";

export async function pauseForSpend(deps: Deps, qs: QueueSet, err: SpendCapExceeded): Promise<void> {
  const paused = (await getSetting<PausedQueues>(deps.db, PAUSED_KEY)) ?? {};
  for (const q of err.queues) {
    await qs.queues[q].pause();
    paused[q] = { provider: err.provider, since: deps.now().toISOString(), reason: err.message };
  }
  await setSetting(deps.db, PAUSED_KEY, paused, "worker");
  await deps.alerter.send({
    key: `spend_cap:${err.provider}:${err.window}`,
    severity: "critical",
    title: `Spend cap hit for ${err.provider} (${err.window}) — queues paused: ${err.queues.join(", ")}`,
    body: `${err.message}\nQueues resume automatically when the window rolls over or the cap is raised in config/limits.json.`,
  });
}

/** Wraps a stage handler with logging, correlation IDs, and the pause/delay behaviour for caps + the kill switch. */
export function makeProcessor(queue: string, handler: Handler, deps: Deps, qs: QueueSet) {
  return async (job: Job<JobData>, token?: string): Promise<unknown> => {
    // scheduler-created jobs carry a placeholder correlation id; give each run a real one
    const data: JobData = /^[0-9a-f-]{36}$/i.test(String(job.data.correlationId)) ? job.data : { ...job.data, correlationId: newCorrelationId() };
    const log = deps.log.child({ queue, jobId: job.id, correlationId: data.correlationId, contentId: data.contentId, attempt: job.attemptsMade + 1 });
    const started = Date.now();
    try {
      const out = await handler({ ...deps, log }, data);
      log.info({ ms: Date.now() - started, out: typeof out === "string" ? out : undefined }, "job done");
      return out;
    } catch (e) {
      if (e instanceof KillSwitchActive) {
        log.warn({ source: e.source }, "kill switch active; delaying job without consuming a retry");
        await job.moveToDelayed(Date.now() + KILL_SWITCH_RECHECK_MS, token);
        throw new DelayedError();
      }
      if (e instanceof SpendCapExceeded) {
        log.warn({ provider: e.provider, window: e.window }, "spend cap hit; pausing queues and delaying job");
        await pauseForSpend({ ...deps, log }, qs, e);
        await job.moveToDelayed(Date.now() + SPEND_RECHECK_MS, token);
        throw new DelayedError();
      }
      if (e instanceof NonRetryableError) throw new UnrecoverableError(e.message);
      log.warn({ err: (e as Error).message, attemptsMade: job.attemptsMade + 1, of: job.opts.attempts }, "job attempt failed");
      throw e;
    }
  };
}

export async function deadLetter(deps: Deps, qs: QueueSet, queue: string, job: Job<JobData>, err: Error): Promise<void> {
  const { db, log } = deps;
  const d = job.data;
  log.error({ queue, jobId: job.id, correlationId: d.correlationId, contentId: d.contentId, err: err.message }, "job dead-lettered after final failure");
  await db.query(`INSERT INTO dead_letters (queue, job_id, content_id, correlation_id, error, attempts, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
    queue,
    job.id ?? null,
    d.contentId ?? null,
    d.correlationId ?? null,
    err.message.slice(0, 2000),
    job.attemptsMade,
    JSON.stringify(d),
  ]);
  await qs.dlq.add("dead-letter", { queue, jobId: job.id, data: d, error: err.message, attempts: job.attemptsMade }, { jobId: `dlq__${queue}__${job.id}__${Date.now()}`.replace(/:/g, "_") });

  if (queue === "publish" && d.publicationId) {
    await db.query(`UPDATE publications SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status IN ('scheduled','publishing')`, [d.publicationId, `dead-lettered: ${err.message}`.slice(0, 500)]);
  } else if (d.contentId && queue !== "analytics") {
    await failContent(db, d.contentId, queue, err.message);
  }
  await deps.alerter.send({ key: `dlq:${queue}`, severity: "critical", title: `Job dead-lettered in "${queue}" after ${job.attemptsMade} attempts`, body: `${err.message}\ncontent=${d.contentId ?? "-"} correlation=${d.correlationId}`, throttleMs: 15 * 60_000 });
}

export interface WorkerHandle {
  workers: Worker[];
  close(timeoutMs?: number): Promise<void>;
}

export function startWorkers(deps: Deps, qs: QueueSet, connection: Redis, handlers: Record<QueueName, Handler>, maintenance: Handler, only?: Array<QueueName | typeof MAINTENANCE_QUEUE>): WorkerHandle {
  const workers: Worker[] = [];
  const names: Array<QueueName | typeof MAINTENANCE_QUEUE> = only ?? [...QUEUE_NAMES, MAINTENANCE_QUEUE];
  for (const name of names) {
    const handler = name === MAINTENANCE_QUEUE ? maintenance : handlers[name];
    const w = new Worker<JobData>(name, makeProcessor(name, handler, deps, qs), { connection, concurrency: CONCURRENCY[name], lockDuration: 120_000 });
    w.on("failed", (job, err) => {
      if (!job) return;
      const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
      if (final) void deadLetter(deps, qs, name, job, err).catch((e) => deps.log.error({ err: (e as Error).message }, "dead-letter handling itself failed"));
    });
    w.on("error", (err) => deps.log.error({ queue: name, err: err.message }, "worker error"));
    workers.push(w);
  }
  return {
    workers,
    close: async (timeoutMs = 60_000) => {
      // graceful: stop taking new jobs and wait for in-flight ones; force-close only after the timeout
      const graceful = Promise.all(workers.map((w) => w.close()));
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
      if ((await Promise.race([graceful.then(() => "done" as const), timer])) === "timeout") {
        deps.log.warn({ timeoutMs }, "graceful shutdown timed out; forcing workers closed");
        await Promise.all(workers.map((w) => w.close(true)));
      }
    },
  };
}
