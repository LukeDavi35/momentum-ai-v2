import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level = process.env.LOG_LEVEL ?? "info", base: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: "momentum-v2", ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["*.access_token", "*.refresh_token", "*.accessToken", "*.refreshToken", "*.apiKey", "*.authorization", "headers.authorization"],
      censor: "[redacted]",
    },
  });
}

export const newCorrelationId = (): string => randomUUID();

/** Logger bound to one piece of content so every line carries the correlation ID. */
export function contentLogger(log: Logger, ids: { correlationId?: string; contentId?: string; stage?: string }): Logger {
  return log.child(ids);
}
