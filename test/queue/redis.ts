import { Redis } from "ioredis";

export const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? "redis://localhost:6390/1";

/** True if a Redis is reachable. Queue tests are skipped (loudly, via describe.skipIf) when it isn't. */
export async function redisUp(): Promise<boolean> {
  const r = new Redis(REDIS_TEST_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
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
