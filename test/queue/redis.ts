import { Redis } from "ioredis";

const BASE = (process.env.REDIS_TEST_URL ?? "redis://localhost:6390").replace(/\/\d+$/, "");
/** Each queue test file gets its own Redis DB so parallel files can never flush each other's jobs. */
export const redisUrl = (db: number): string => `${BASE}/${db}`;
export const REDIS_TEST_URL = redisUrl(1);

/** True if a Redis is reachable. Queue tests are skipped (loudly, via describe.skipIf) when it isn't. */
export async function redisUp(): Promise<boolean> {
  const r = new Redis(redisUrl(1), { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
