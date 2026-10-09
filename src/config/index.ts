import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  DRY_RUN: bool(true),
  KILL_SWITCH: bool(false),
  MAX_POSTS_PER_DAY: z.coerce.number().int().positive().default(9),
  CONFIG_DIR: z.string().default("./config"),
  DATA_DIR: z.string().default("./data"),
  MEDIA_DIR: z.string().default("./out/media"),
  DATABASE_URL: optStr,
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().int().default(8080),
  ADMIN_TOKEN: optStr,
  PUBLIC_BASE_URL: optStr,
  TOKEN_ENC_KEY: optStr,
  MEDIA_SIGNING_SECRET: optStr,

  ANTHROPIC_API_KEY: optStr,
  LLM_MODEL_WRITER: z.string().default("claude-sonnet-5"),
  LLM_MODEL_REVIEWER: z.string().default("claude-sonnet-5"),
  LLM_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

  ELEVENLABS_API_KEY: optStr,
  ELEVENLABS_VOICE_ID: optStr,
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  OPENAI_API_KEY: optStr,
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"),
  OPENAI_TTS_VOICE: z.string().default("onyx"),
  ALLOW_DEV_TTS: bool(true),

  RENDERER: z.enum(["ffmpeg", "remotion"]).default("ffmpeg"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FONT_FILE: z.string().default("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
  CHROMIUM_PATH: optStr,

  REDDIT_CLIENT_ID: optStr,
  REDDIT_CLIENT_SECRET: optStr,

  TIKTOK_CLIENT_KEY: optStr,
  TIKTOK_CLIENT_SECRET: optStr,
  INSTAGRAM_APP_ID: optStr,
  INSTAGRAM_APP_SECRET: optStr,
  GOOGLE_CLIENT_ID: optStr,
  GOOGLE_CLIENT_SECRET: optStr,

  DISCORD_WEBHOOK_URL: optStr,
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  GENERIC_WEBHOOK_URL: optStr,
  SMTP_URL: optStr,
  ALERT_EMAIL_TO: optStr,
  ALERT_EMAIL_FROM: optStr,
});
export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

const platformScheduleSchema = z.object({
  enabled: z.boolean(),
  postsPerDay: z.number().int().min(0),
  peakTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
  jitterMinutes: z.number().min(0),
});

export const scheduleSchema = z.object({
  timezone: z.string(),
  platforms: z.object({ tiktok: platformScheduleSchema, instagram: platformScheduleSchema, youtube: platformScheduleSchema }),
  ingest: z.object({
    rssEveryMinutes: z.number().positive(),
    trendsEveryMinutes: z.number().positive(),
    redditEveryMinutes: z.number().positive(),
    internalEveryMinutes: z.number().positive(),
  }),
  ideate: z.object({ everyMinutes: z.number().positive(), candidatesPerCycle: z.number().int().positive(), keepTopN: z.number().int().positive() }),
  plan: z.object({ dailyAt: z.string().regex(/^\d{2}:\d{2}$/), inventoryTargetPieces: z.number().int().positive() }),
  monitor: z.object({ everyMinutes: z.number().positive() }),
  analytics: z.object({ checkpoints: z.array(z.enum(["1h", "24h", "7d"])).min(1) }),
  learning: z.object({ weeklyCron: z.string() }),
});
export type ScheduleConfig = z.infer<typeof scheduleSchema>;

export const TEMPLATES = ["news_flash", "stat_spotlight", "race_recap", "training_tip", "quick_explainer"] as const;
export type Template = (typeof TEMPLATES)[number];
export const PILLARS = ["running", "fitness", "track_and_field", "sports_news"] as const;
export type Pillar = (typeof PILLARS)[number];

export const pillarsSchema = z.object({
  pillars: z.record(z.enum(PILLARS), z.object({ weight: z.number().min(0), subreddits: z.array(z.string()) })),
  templates: z.record(z.enum(TEMPLATES), z.object({ pillars: z.array(z.enum(PILLARS)), description: z.string() })),
});
export type PillarsConfig = z.infer<typeof pillarsSchema>;

export const qaSchema = z.object({
  minScore: z.number().min(1).max(10),
  maxRegenerations: z.number().int().min(0),
  consecutiveFailureAlert: z.number().int().positive(),
  technical: z.object({
    minDurationS: z.number(),
    maxDurationS: z.number(),
    width: z.number().int(),
    height: z.number().int(),
    maxFileSizeMB: z.number(),
    targetLufs: z.number(),
    lufsTolerance: z.number(),
    maxTruePeakDb: z.number(),
    maxBlackSeconds: z.number(),
    maxHookWords: z.number().int(),
    captionSyncToleranceS: z.number(),
  }),
});
export type QaConfig = z.infer<typeof qaSchema>;

export const PROVIDERS = ["anthropic", "elevenlabs", "openai", "render"] as const;
export type SpendProvider = (typeof PROVIDERS)[number];

export const limitsSchema = z.object({
  currency: z.string(),
  providers: z.record(z.enum(PROVIDERS), z.object({ daily: z.number().min(0), monthly: z.number().min(0) })),
  queueBacklogAlert: z.number().int().positive(),
  maxPostsPerDay: z.number().int().positive(),
});
export type LimitsConfig = z.infer<typeof limitsSchema>;

export const pricingSchema = z.object({
  llm: z.record(z.string(), z.object({ inPerM: z.number(), outPerM: z.number() })),
  elevenlabsPerKChars: z.number(),
  openaiTtsPerKChars: z.number(),
  openaiEmbeddingPerMTokens: z.number(),
  renderPerMinute: z.number(),
});
export type PricingConfig = z.infer<typeof pricingSchema>;

export const sourcesSchema = z.object({
  rss: z.array(z.object({ id: z.string(), url: z.string().url(), pillar: z.enum(PILLARS), kind: z.enum(["news", "results"]) })),
  trends: z.object({ url: z.string().url(), keywords: z.array(z.string()) }),
  reddit: z.object({ userAgent: z.string(), limit: z.number().int().positive() }),
});
export type SourcesConfig = z.infer<typeof sourcesSchema>;

export interface AppConfig {
  env: Env;
  schedule: ScheduleConfig;
  pillars: PillarsConfig;
  qa: QaConfig;
  limits: LimitsConfig;
  pricing: PricingConfig;
  sources: SourcesConfig;
}

function readJson<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read config ${path}: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid config ${path}: ${parsed.error.message}`);
  return parsed.data;
}

export function loadConfig(env: Env = loadEnv()): AppConfig {
  const dir = env.CONFIG_DIR;
  return {
    env,
    schedule: readJson(dir, "schedule.json", scheduleSchema),
    pillars: readJson(dir, "pillars.json", pillarsSchema),
    qa: readJson(dir, "qa.json", qaSchema),
    limits: readJson(dir, "limits.json", limitsSchema),
    pricing: readJson(dir, "pricing.json", pricingSchema.passthrough() as unknown as z.ZodType<PricingConfig>),
    sources: readJson(dir, "sources.json", sourcesSchema),
  };
}

/** The hard posting cap is the stricter of the env var and limits.json. */
export function effectiveMaxPostsPerDay(cfg: AppConfig): number {
  return Math.min(cfg.env.MAX_POSTS_PER_DAY, cfg.limits.maxPostsPerDay);
}
