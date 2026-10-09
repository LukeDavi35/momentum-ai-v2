import { Redis } from "ioredis";

/** BullMQ workers need maxRetriesPerRequest: null so blocking commands don't time out during Redis blips. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
