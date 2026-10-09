import type { JobsOptions } from "bullmq";
import type { AppConfig } from "../config/index.js";
import { newCorrelationId } from "../logger.js";
import { MAINTENANCE_QUEUE } from "./names.js";
import type { QueueSet } from "./queues.js";

const mins = (m: number): number => Math.round(m * 60_000);
const TEMPLATE_OPTS: JobsOptions = { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 }, attempts: 3, backoff: { type: "exponential", delay: 10_000 } };
const PLACEHOLDER = "scheduled"; // replaced with a real UUID per run by the worker

/**
 * Registers every repeating job with BullMQ job schedulers. Idempotent (upsert), so restarting the
 * worker never duplicates schedules; cadence comes from config/schedule.json.
 */
export async function installSchedules(qs: QueueSet, cfg: AppConfig): Promise<string[]> {
  const s = cfg.schedule;
  const tz = s.timezone;
  const installed: string[] = [];
  const add = async (queue: "ingest" | "ideate" | typeof MAINTENANCE_QUEUE, id: string, repeat: { every?: number; pattern?: string; tz?: string }, kind: string) => {
    const q = queue === MAINTENANCE_QUEUE ? qs.maintenance : qs.queues[queue];
    await q.upsertJobScheduler(id, repeat, { name: queue, data: { kind, correlationId: PLACEHOLDER }, opts: TEMPLATE_OPTS });
    installed.push(id);
  };

  await add("ingest", "ingest-rss", { every: mins(s.ingest.rssEveryMinutes) }, "rss");
  await add("ingest", "ingest-trends", { every: mins(s.ingest.trendsEveryMinutes) }, "trends");
  await add("ingest", "ingest-reddit", { every: mins(s.ingest.redditEveryMinutes) }, "reddit");
  await add("ingest", "ingest-internal", { every: mins(s.ingest.internalEveryMinutes) }, "internal");
  await add("ideate", "ideate-cycle", { every: mins(s.ideate.everyMinutes) }, "cycle");
  const [h, m] = s.plan.dailyAt.split(":").map(Number);
  await add("ideate", "daily-housekeeping", { pattern: `${m} ${h} * * *`, tz }, "housekeeping");
  await add(MAINTENANCE_QUEUE, "reconcile", { every: mins(10) }, "reconcile");
  await add(MAINTENANCE_QUEUE, "monitor", { every: mins(s.monitor.everyMinutes) }, "monitor");
  await add(MAINTENANCE_QUEUE, "refresh-tokens", { every: mins(30) }, "refresh-tokens");
  await add(MAINTENANCE_QUEUE, "weekly-learning", { pattern: s.learning.weeklyCron, tz }, "weekly-learning");
  return installed;
}

/** One-off kick at start-up so a fresh deploy doesn't wait a full interval for its first content. */
export async function bootKick(qs: QueueSet): Promise<void> {
  const stamp = Date.now();
  for (const kind of ["rss", "trends", "reddit"]) {
    await qs.queues.ingest.add("ingest", { kind, correlationId: newCorrelationId() }, { jobId: `boot__ingest__${kind}__${stamp}` });
  }
  await qs.queues.ideate.add("ideate", { kind: "cycle", correlationId: newCorrelationId() }, { jobId: `boot__ideate__${stamp}`, delay: 45_000 }); // after ingest has had time to run
}
