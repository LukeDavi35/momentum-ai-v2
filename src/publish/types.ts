import type { Platform } from "../config/index.js";
import type { PlatformMetadata } from "./metadata.js";

export interface PublishRequest {
  contentId: string;
  videoPath: string;
  coverPath?: string;
  /** Publicly fetchable HTTPS URL of the video (Instagram pulls from it). */
  mediaUrl?: string;
  coverUrl?: string;
  durationS: number;
  meta: PlatformMetadata;
  /**
   * Called immediately before the first IRREVERSIBLE platform call (create post / publish container).
   * It re-checks the kill switch and posting caps, so a stale queued job can never slip through.
   */
  assertLive(): Promise<void>;
}

export interface PublishResult {
  externalId: string;
  url?: string;
  /** Non-fatal observations, e.g. "posted SELF_ONLY because the TikTok app is unaudited". */
  warnings?: string[];
}

export interface Metrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  follows?: number;
  watchTimeS?: number;
  avgViewDurationS?: number;
  retentionPct?: number;
  raw?: unknown;
}

export interface Publisher {
  readonly platform: Platform;
  readonly live: boolean;
  publish(req: PublishRequest): Promise<PublishResult>;
  metrics(externalId: string, ctx?: { caption?: string; publishedAt?: Date }): Promise<Metrics>;
}

/**
 * retryable:  nothing public happened yet, safe for the queue to retry.
 * ambiguous:  we may or may not have posted (e.g. timeout after the final publish call). NEVER auto-retried —
 *             a retry could double-post — the item is parked as failed and an alert asks a human to check.
 */
export class PublishError extends Error {
  constructor(message: string, public readonly opts: { retryable: boolean; ambiguous?: boolean; status?: number } = { retryable: true }) {
    super(message);
    this.name = "PublishError";
  }
  get retryable(): boolean {
    return this.opts.retryable;
  }
  get ambiguous(): boolean {
    return !!this.opts.ambiguous;
  }
}

/** Rate limits / transient server errors are retryable; other 4xx (bad request, auth, policy) are not. */
export function httpFailure(what: string, status: number, body: string): PublishError {
  const retryable = status === 429 || status >= 500;
  return new PublishError(`${what} failed: HTTP ${status} ${body.slice(0, 300)}`, { retryable, status });
}
