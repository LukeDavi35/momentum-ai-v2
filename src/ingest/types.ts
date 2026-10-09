import type { Pillar } from "../config/index.js";

export type SourceKind = "news" | "results" | "trend" | "reddit" | "internal";

/** Only these may be cited as a factual source for a claim. Everything else is a topic signal. */
export const CITABLE_KINDS: SourceKind[] = ["news", "results"];

export interface RawItem {
  source: string;
  kind: SourceKind;
  pillar?: Pillar;
  url?: string;
  title: string;
  summary: string;
  bodyText?: string;
  publishedAt?: Date;
  metrics?: Record<string, number | string>;
}

export interface SourceItem {
  id: string;
  source: string;
  kind: SourceKind;
  pillar: Pillar | null;
  url: string | null;
  title: string;
  summary: string;
  bodyText: string;
  publishedAt: Date | null;
  fetchedAt: Date;
  metrics: Record<string, any>;
  embedding: import("../ideate/embeddings.js").Embedding | null;
}

export type FetchLike = typeof fetch;

export interface IngestOutcome {
  source: string;
  fetched: number;
  inserted: number;
  error?: string;
}
