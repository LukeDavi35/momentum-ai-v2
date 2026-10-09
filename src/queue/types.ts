import type { AppConfig } from "../config/index.js";
import type { Db } from "../db/db.js";
import type { Embedder } from "../ideate/embeddings.js";
import type { LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import type { Alerter } from "../safety/alerts.js";
import type { SpendTracker } from "../safety/spend.js";
import type { Runner } from "../media/exec.js";
import type { TtsProvider } from "../voice/types.js";
import type { QueueName } from "./names.js";

/** Payload carried by every job. `correlationId` follows a piece of content end to end. */
export interface JobData {
  correlationId: string;
  contentId?: string;
  /** Regeneration round (0 = first attempt). Part of the deterministic jobId. */
  regen?: number;
  /** ingest: which source group. publish: "schedule" | "publish". analytics: see checkpoint. */
  kind?: string;
  publicationId?: string;
  checkpoint?: "1h" | "24h" | "7d";
}

export interface EnqueueOptions {
  delayMs?: number;
  /** Override the deterministic id. Re-adding a job with an existing id is a no-op (idempotent enqueue). */
  jobId?: string;
}

export type Enqueue = (queue: QueueName, data: JobData, opts?: EnqueueOptions) => Promise<void>;

/** Everything a stage handler needs. Handlers are plain functions of (Deps, JobData) so they test without Redis. */
export interface Deps {
  cfg: AppConfig;
  db: Db;
  log: Logger;
  alerter: Alerter;
  spend: SpendTracker;
  llm: LlmClient;
  embedder: Embedder;
  enqueue: Enqueue;
  now: () => Date;
  fetchImpl?: typeof fetch;
  /** Test/ops seams — production leaves these undefined and the real implementations are built from config. */
  tts?: TtsProvider[];
  runner?: Runner;
}

/** Deterministic job id: re-enqueueing the same logical step is a no-op. BullMQ forbids ':' in ids. */
export function jobIdFor(queue: QueueName, data: JobData): string {
  const parts: string[] = [queue];
  if (data.contentId) parts.push(data.contentId);
  if (data.publicationId) parts.push(data.publicationId);
  if (data.kind) parts.push(data.kind);
  if (data.checkpoint) parts.push(data.checkpoint);
  if (data.regen !== undefined) parts.push(`r${data.regen}`);
  return parts.join("__");
}
