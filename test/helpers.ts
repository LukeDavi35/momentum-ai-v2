import { loadConfig, loadEnv, type AppConfig } from "../src/config/index.js";
import { openPglite, type Db } from "../src/db/db.js";
import { createLogger, type Logger } from "../src/logger.js";

let shared: Db | undefined;

/**
 * One in-memory Postgres (PGlite) per test file — booting it costs ~3s — truncated between
 * tests, so every test still starts from an empty database.
 */
export async function testDb(): Promise<Db> {
  shared ??= await openPglite();
  const tables = await shared.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
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
