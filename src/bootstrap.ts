import { Redis } from "ioredis";
import { loadConfig, type AppConfig } from "./config/index.js";
import { openDb, type Db } from "./db/db.js";
import { FallbackEmbedder, LocalHashEmbedder, OpenAIEmbedder, type Embedder } from "./ideate/embeddings.js";
import { ensureInitialWeights } from "./ideate/weights.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { LlmClient } from "./llm/client.js";
import { StubProvider } from "./llm/stub.js";
import { createLogger, type Logger } from "./logger.js";
import { buildPublishers } from "./publish/factory.js";
import { makeRefresher } from "./publish/oauth.js";
import { TokenStore } from "./publish/tokens.js";
import { createRedis } from "./queue/connection.js";
import { createQueues, makeEnqueue, type QueueSet } from "./queue/queues.js";
import type { Deps } from "./queue/types.js";
import { Alerter } from "./safety/alerts.js";
import { SpendTracker } from "./safety/spend.js";

/**
 * Live mode (DRY_RUN=false) refuses to start unless everything that makes autonomous posting safe is
 * configured. Better to crash at boot with a clear list than to half-run unattended.
 */
export function liveReadinessProblems(cfg: AppConfig): string[] {
  const e = cfg.env;
  const p: string[] = [];
  if (e.DRY_RUN) return p;
  if (!e.ANTHROPIC_API_KEY) p.push("ANTHROPIC_API_KEY (the stub LLM is dry-run only)");
  if (!(e.ELEVENLABS_API_KEY && e.ELEVENLABS_VOICE_ID) && !e.OPENAI_API_KEY) p.push("a TTS provider: ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or OPENAI_API_KEY (the dev voice is dry-run only)");
  if (!e.TOKEN_ENC_KEY) p.push("TOKEN_ENC_KEY (64 hex chars) to encrypt OAuth tokens");
  if (!e.ADMIN_TOKEN) p.push("ADMIN_TOKEN to protect the dashboard and kill switch");
  if (!e.PUBLIC_BASE_URL) p.push("PUBLIC_BASE_URL (https) — Instagram fetches videos from it and OAuth redirects to it");
  if (e.PUBLIC_BASE_URL && !e.PUBLIC_BASE_URL.startsWith("https://")) p.push("PUBLIC_BASE_URL must be https://");
  if (!e.MEDIA_SIGNING_SECRET) p.push("MEDIA_SIGNING_SECRET");
  if (!e.DATABASE_URL) p.push("DATABASE_URL (embedded PGlite is for dry-run/dev only)");
  if (!(e.DISCORD_WEBHOOK_URL || (e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID) || e.GENERIC_WEBHOOK_URL || (e.SMTP_URL && e.ALERT_EMAIL_TO))) p.push("at least one alert channel (Discord / Telegram / webhook / email) — an unattended system must be able to reach you");
  return p;
}

export interface App {
  cfg: AppConfig;
  log: Logger;
  db: Db;
  redis: Redis;
  qs: QueueSet;
  deps: Deps;
  tokens?: TokenStore;
  close(): Promise<void>;
}

export async function bootstrap(opts: { cfg?: AppConfig } = {}): Promise<App> {
  const cfg = opts.cfg ?? loadConfig();
  const log = createLogger(cfg.env.LOG_LEVEL);
  const problems = liveReadinessProblems(cfg);
  if (problems.length) throw new Error(`DRY_RUN=false but the system is not ready for live posting. Missing:\n - ${problems.join("\n - ")}`);

  const db = await openDb({ databaseUrl: cfg.env.DATABASE_URL, dataDir: cfg.env.DATA_DIR });
  await ensureInitialWeights(db);
  const redis = createRedis(cfg.env.REDIS_URL);
  const qs = createQueues(redis);

  const alerter = new Alerter(db, cfg.env, log);
  const spend = new SpendTracker(db, cfg.limits, cfg.pricing);
  const provider = cfg.env.ANTHROPIC_API_KEY ? new AnthropicProvider(cfg.env.ANTHROPIC_API_KEY) : new StubProvider();
  if (!cfg.env.ANTHROPIC_API_KEY) log.warn("ANTHROPIC_API_KEY not set: using the deterministic STUB LLM (dry-run only). Output is extractive, not model-written.");
  const llm = new LlmClient(provider, spend, cfg.env, log);
  const local = new LocalHashEmbedder();
  const embedder: Embedder = cfg.env.OPENAI_API_KEY ? new FallbackEmbedder(new OpenAIEmbedder(cfg.env.OPENAI_API_KEY, spend), local) : local;

  const tokens = cfg.env.TOKEN_ENC_KEY ? new TokenStore(db, cfg.env.TOKEN_ENC_KEY, log, alerter, makeRefresher(cfg)) : undefined;
  const deps: Deps = {
    cfg,
    db,
    log,
    alerter,
    spend,
    llm,
    embedder,
    enqueue: makeEnqueue(qs),
    now: () => new Date(),
    publishers: buildPublishers(cfg, tokens),
  };
  log.info({ dryRun: cfg.env.DRY_RUN, renderer: cfg.env.RENDERER, llm: provider.name, db: db.kind, embedder: embedder.name, alertChannels: alerter.configuredChannels() }, "bootstrapped");

  return {
    cfg,
    log,
    db,
    redis,
    qs,
    deps,
    tokens,
    close: async () => {
      await qs.close();
      await redis.quit().catch(() => undefined);
      await db.close();
    },
  };
}
