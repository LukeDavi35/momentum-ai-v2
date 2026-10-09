import type { AppConfig, Pillar } from "../config/index.js";
import type { Db } from "../db/db.js";
import type { Embedder } from "../ideate/embeddings.js";
import type { Logger } from "../logger.js";
import { fetchRss } from "./rss.js";
import { fetchTrends } from "./trends.js";
import { fetchSubreddit, getRedditToken } from "./reddit.js";
import { storeItems } from "./store.js";
import type { FetchLike, IngestOutcome, RawItem } from "./types.js";

export type IngestSource = "rss" | "trends" | "reddit" | "internal";

export interface IngestDeps {
  db: Db;
  cfg: AppConfig;
  embedder: Embedder;
  log: Logger;
  fetchImpl?: FetchLike;
  /** Supplies "our own top-performing past posts" (implemented by the learning module). */
  internalItems?: () => Promise<RawItem[]>;
}

/**
 * Runs one source group. One failing feed never blocks the others; the job only throws if
 * EVERY target failed (so BullMQ retries with backoff), otherwise failures are returned in the outcome.
 */
export async function runIngest(deps: IngestDeps, source: IngestSource): Promise<IngestOutcome[]> {
  const { cfg, db, embedder, log } = deps;
  const f = deps.fetchImpl ?? fetch;
  const targets: Array<{ name: string; run: () => Promise<RawItem[]> }> = [];

  if (source === "rss") {
    for (const feed of cfg.sources.rss) targets.push({ name: feed.id, run: () => fetchRss(feed, f) });
  } else if (source === "trends") {
    targets.push({ name: "google-trends", run: () => fetchTrends(cfg.sources.trends.url, cfg.sources.trends.keywords, f) });
  } else if (source === "reddit") {
    const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret } = cfg.env;
    if (!id || !secret) {
      log.info("reddit credentials not configured; skipping");
      return [];
    }
    const ua = cfg.sources.reddit.userAgent;
    let tokenP: Promise<string> | undefined;
    const token = () => (tokenP ??= getRedditToken({ clientId: id, clientSecret: secret, userAgent: ua }, f));
    for (const [pillar, p] of Object.entries(cfg.pillars.pillars)) {
      for (const sub of p.subreddits) {
        targets.push({ name: `r/${sub}`, run: async () => fetchSubreddit(await token(), ua, sub, pillar as Pillar, cfg.sources.reddit.limit, f) });
      }
    }
  } else if (source === "internal") {
    targets.push({ name: "internal", run: async () => (await deps.internalItems?.()) ?? [] });
  }

  const outcomes: IngestOutcome[] = [];
  for (const t of targets) {
    try {
      const items = await t.run();
      const { inserted } = await storeItems(db, embedder, items);
      outcomes.push({ source: t.name, fetched: items.length, inserted });
      log.info({ source: t.name, fetched: items.length, inserted }, "ingested");
    } catch (e) {
      outcomes.push({ source: t.name, fetched: 0, inserted: 0, error: (e as Error).message });
      log.warn({ source: t.name, err: (e as Error).message }, "ingest source failed");
    }
  }
  if (outcomes.length > 0 && outcomes.every((o) => o.error)) throw new Error(`All ${source} sources failed: ${outcomes.map((o) => `${o.source}: ${o.error}`).join("; ")}`);
  return outcomes;
}
