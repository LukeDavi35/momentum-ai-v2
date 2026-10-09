import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { DEAD_LETTER_QUEUE, MAINTENANCE_QUEUE, QUEUE_NAMES, type QueueName } from "./names.js";
import { jobIdFor, type Enqueue, type JobData } from "./types.js";

/** Retries with exponential backoff (5s, 10s, 20s, 40s) — max 5 attempts, then the worker dead-letters the job. */
export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 7 * 86400, count: 5000 },
  removeOnFail: false,
};

export interface QueueSet {
  queues: Record<QueueName, Queue>;
  maintenance: Queue;
  dlq: Queue;
  all(): Queue[];
  close(): Promise<void>;
}

export function createQueues(connection: Redis): QueueSet {
  const queues = Object.fromEntries(QUEUE_NAMES.map((n) => [n, new Queue(n, { connection, defaultJobOptions: DEFAULT_JOB_OPTS })])) as Record<QueueName, Queue>;
  const maintenance = new Queue(MAINTENANCE_QUEUE, { connection, defaultJobOptions: { ...DEFAULT_JOB_OPTS, attempts: 3 } });
  const dlq = new Queue(DEAD_LETTER_QUEUE, { connection, defaultJobOptions: { removeOnComplete: false, removeOnFail: false } });
  return {
    queues,
    maintenance,
    dlq,
    all: () => [...Object.values(queues), maintenance, dlq],
    close: async () => void (await Promise.all([...Object.values(queues), maintenance, dlq].map((q) => q.close()))),
  };
}

/**
 * Idempotent enqueue: the job id is derived from (queue, content, publication, kind, checkpoint, regen),
 * and BullMQ ignores an add() whose id already exists — so re-enqueueing the same logical step is a no-op.
 */
export function makeEnqueue(qs: QueueSet): Enqueue {
  return async (queue, data: JobData, opts = {}) => {
    await qs.queues[queue].add(queue, data, { jobId: opts.jobId ?? jobIdFor(queue, data), delay: opts.delayMs && opts.delayMs > 0 ? Math.round(opts.delayMs) : undefined });
  };
}
