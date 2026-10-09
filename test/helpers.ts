import { loadConfig, loadEnv, type AppConfig } from "../src/config/index.js";
import { openPglite, openPostgres, type Db } from "../src/db/db.js";
import { createLogger, type Logger } from "../src/logger.js";

let shared: Db | undefined;

/**
 * One in-memory Postgres (PGlite) per test file — booting it costs ~3s — truncated between
 * tests, so every test still starts from an empty database.
 */
export async function testDb(): Promise<Db> {
  shared ??= process.env.TEST_DATABASE_URL ? await openIsolatedPostgres(process.env.TEST_DATABASE_URL) : await openPglite();
  const tables = await shared.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations'`,
  );
  await shared.exec(`TRUNCATE ${tables.rows.map((t) => t.tablename).join(", ")} RESTART IDENTITY CASCADE`);
  return shared;
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const env = loadEnv({
    NODE_ENV: "test",
    DRY_RUN: "true",
    KILL_SWITCH: "false",
    CONFIG_DIR: "./config",
    DATA_DIR: "./data/test",
    MEDIA_DIR: "./out/test-media",
    LOG_LEVEL: "silent",
    ...overrides,
  });
  return loadConfig(env);
}

export const silentLogger = (): Logger => createLogger("silent");

import { LocalHashEmbedder } from "../src/ideate/embeddings.js";
import { LlmClient } from "../src/llm/client.js";
import type { CompleteRequest, CompleteResponse, LlmProvider } from "../src/llm/types.js";
import type { Deps, Enqueue, JobData } from "../src/queue/types.js";
import { Alerter } from "../src/safety/alerts.js";
import { SpendTracker } from "../src/safety/spend.js";
import type { QueueName } from "../src/queue/names.js";

/** Fake LLM: a function from the request to a JSON-serialisable reply (or a raw string / thrown error). */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  constructor(
    private readonly reply: (req: CompleteRequest) => unknown,
    readonly billable = false,
  ) {}
  calls: CompleteRequest[] = [];
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.calls.push(req);
    const r = this.reply(req);
    return { text: typeof r === "string" ? r : JSON.stringify(r), inputTokens: 100, outputTokens: 50 };
  }
}

export interface EnqueuedJob {
  queue: QueueName;
  data: JobData;
  opts?: { delayMs?: number; jobId?: string };
}

export async function makeDeps(opts: {
  reply?: (req: CompleteRequest) => unknown;
  /** Use a specific provider (e.g. StubProvider) instead of the scripted FakeProvider. */
  provider?: LlmProvider;
  billable?: boolean;
  env?: Record<string, string | undefined>;
  now?: Date;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ deps: Deps; db: Db; enqueued: EnqueuedJob[]; provider: FakeProvider }> {
  const db = await testDb();
  const cfg = testConfig(opts.env);
  const log = silentLogger();
  const now = opts.now ?? new Date("2026-10-09T12:00:00Z");
  const spend = new SpendTracker(db, cfg.limits, cfg.pricing, () => now);
  const fake = new FakeProvider(opts.reply ?? (() => ({})), opts.billable ?? false);
  const provider = fake;
  const enqueued: EnqueuedJob[] = [];
  const enqueue: Enqueue = async (queue, data, o) => void enqueued.push({ queue, data, opts: o });
  const deps: Deps = {
    cfg,
    db,
    log,
    alerter: new Alerter(db, cfg.env, log),
    spend,
    llm: new LlmClient(opts.provider ?? fake, spend, cfg.env, log),
    embedder: new LocalHashEmbedder(),
    enqueue,
    now: () => now,
    fetchImpl: opts.fetchImpl,
  };
  return { deps, db, enqueued, provider };
}

/** Real Postgres, one private schema per test file/process so parallel files never see each other's rows. */
async function openIsolatedPostgres(url: string): Promise<Db> {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await openPostgres(url);
  await admin.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await admin.close();
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return openPostgres(u.toString());
}
