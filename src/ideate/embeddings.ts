import { createHash } from "node:crypto";
import type { SpendTracker } from "../safety/spend.js";

/** A vector tagged with the model that produced it; vectors from different models are never compared. */
export interface Embedding {
  model: string;
  vector: number[];
}

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<Embedding[]>;
}

const DIM = 256;

function hashIndex(token: string): { idx: number; sign: 1 | -1 } {
  const h = createHash("md5").update(token).digest();
  return { idx: h.readUInt16BE(0) % DIM, sign: (h[2]! & 1) === 0 ? 1 : -1 };
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "and", "for", "is", "at", "by", "with", "as", "from", "after", "his", "her", "its", "has", "have", "will"]);

/**
 * Deterministic offline embedding: signed hashing of word unigrams, bigrams and character
 * trigrams into 256 dims, L2-normalised. Captures lexical/topical overlap, which is exactly
 * what near-duplicate-headline detection needs. Not a semantic model — documented in DECISIONS.md.
 */
export class LocalHashEmbedder implements Embedder {
  readonly name = "local-hash-256";

  async embed(texts: string[]): Promise<Embedding[]> {
    return texts.map((t) => ({ model: this.name, vector: this.one(t) }));
  }

  private one(text: string): number[] {
    const v = new Array<number>(DIM).fill(0);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w));
    const add = (tok: string, w: number) => {
      const { idx, sign } = hashIndex(tok);
      v[idx]! += sign * w;
    };
    for (let i = 0; i < words.length; i++) {
      add(`w:${words[i]}`, 1.0);
      if (i + 1 < words.length) add(`b:${words[i]}_${words[i + 1]}`, 0.8);
      const w = words[i]!;
      for (let j = 0; j + 3 <= w.length; j++) add(`c:${w.slice(j, j + 3)}`, 0.25);
    }
    return normalise(v);
  }
}

function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

/** Cosine similarity of two tagged embeddings; 0 when they come from different models. */
export function similarity(a: Embedding | null | undefined, b: Embedding | null | undefined): number {
  if (!a || !b || a.model !== b.model) return 0;
  return cosine(a.vector, b.vector);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class OpenAIEmbedder implements Embedder {
  readonly name = "openai-text-embedding-3-small-256";
  constructor(
    private readonly apiKey: string,
    private readonly spend: SpendTracker,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<Embedding[]> {
    const approxTokens = texts.reduce((s, t) => s + Math.ceil(t.length / 3.5), 0);
    await this.spend.guard("openai", this.spend.embeddingCost(approxTokens));
    const res = await this.fetchImpl("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: DIM }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data: { embedding: number[] }[]; usage?: { total_tokens?: number } };
    await this.spend.record({
      provider: "openai",
      category: "embeddings",
      usd: this.spend.embeddingCost(json.usage?.total_tokens ?? approxTokens),
      units: json.usage?.total_tokens ?? approxTokens,
    });
    return json.data.map((d) => ({ model: this.name, vector: normalise(d.embedding) }));
  }
}

/** OpenAI if keyed and under cap, with automatic fallback to the local embedder on any failure. */
export class FallbackEmbedder implements Embedder {
  constructor(private readonly primary: Embedder, private readonly fallback: Embedder) {}
  get name(): string {
    return `${this.primary.name}|${this.fallback.name}`;
  }
  async embed(texts: string[]): Promise<Embedding[]> {
    try {
      return await this.primary.embed(texts);
    } catch {
      return this.fallback.embed(texts);
    }
  }
}
