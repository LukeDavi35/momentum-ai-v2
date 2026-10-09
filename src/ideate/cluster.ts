import type { Pillar } from "../config/index.js";
import { CITABLE_KINDS, type SourceItem } from "../ingest/types.js";
import { similarity, type Embedding } from "./embeddings.js";

/** Similarity thresholds depend on the embedding model: the local n-gram hash is lexical, so it scores lower. */
export function thresholds(model: string | undefined): { cluster: number; duplicate: number } {
  return model?.startsWith("openai") ? { cluster: 0.62, duplicate: 0.82 } : { cluster: 0.42, duplicate: 0.62 };
}

export interface Cluster {
  id: string;
  items: SourceItem[];
  citable: SourceItem[];
  pillar: Pillar;
  headline: string;
  sources: string[];
  newestAgeHours: number;
  recent6h: number;
  recent24h: number;
  trendTraffic: number;
  redditScore: number;
  velocity: number;
  embedding: Embedding | null;
}

const PILLAR_KEYWORDS: Array<[Pillar, RegExp]> = [
  ["running", /\b(run|runner|running|marathon|half[- ]marathon|jog|5k|10k|parkrun|ultra|trail)\b/i],
  ["fitness", /\b(gym|workout|fitness|strength|lift|lifting|protein|yoga|hiit|mobility|training plan|exercise)\b/i],
  ["track_and_field", /\b(athletics|sprint|sprinter|hurdles|javelin|diamond league|world athletics|track|relay|decathlon|heptathlon|pole vault|high jump|long jump|shot put)\b/i],
];

export function inferPillar(text: string, hinted: (Pillar | null)[]): Pillar {
  const counts = new Map<Pillar, number>();
  for (const h of hinted) if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  for (const [p, re] of PILLAR_KEYWORDS) if (re.test(text)) return p;
  return "sports_news";
}

const log10p = (n: number): number => Math.log10(Math.max(0, n) + 1);

/**
 * Trend velocity in [0,1]: how fast a story is spreading, from observable signals —
 * fresh items in the last 6h/24h, number of independent sources, Google Trends traffic,
 * Reddit score — decayed by the age of the newest item.
 */
export function computeVelocity(c: Pick<Cluster, "recent6h" | "recent24h" | "sources" | "trendTraffic" | "redditScore" | "newestAgeHours">): number {
  const signal =
    0.3 * Math.min(1, c.recent6h / 3) +
    0.25 * Math.min(1, c.sources.length / 3) +
    0.15 * Math.min(1, c.recent24h / 6) +
    0.15 * Math.min(1, log10p(c.trendTraffic) / 5) +
    0.15 * Math.min(1, log10p(c.redditScore) / 4);
  return Math.max(0, Math.min(1, signal * Math.exp(-c.newestAgeHours / 36)));
}

function centroid(embs: Embedding[]): Embedding | null {
  const first = embs[0];
  if (!first) return null;
  const same = embs.filter((e) => e.model === first.model);
  const v = new Array<number>(first.vector.length).fill(0);
  for (const e of same) for (let i = 0; i < v.length; i++) v[i]! += e.vector[i]!;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return { model: first.model, vector: v.map((x) => x / n) };
}

/** Greedy single-pass clustering of recent source items by embedding similarity. */
export function clusterItems(items: SourceItem[], now = new Date()): Cluster[] {
  const sorted = [...items].sort((a, b) => (b.publishedAt ?? b.fetchedAt).getTime() - (a.publishedAt ?? a.fetchedAt).getTime());
  const groups: Array<{ items: SourceItem[]; centroid: Embedding | null }> = [];
  for (const item of sorted) {
    const thr = thresholds(item.embedding?.model).cluster;
    let best: { g: (typeof groups)[number]; sim: number } | undefined;
    for (const g of groups) {
      const sim = similarity(item.embedding, g.centroid);
      if (sim >= thr && (!best || sim > best.sim)) best = { g, sim };
    }
    if (best) {
      best.g.items.push(item);
      best.g.centroid = centroid(best.g.items.map((i) => i.embedding).filter((e): e is Embedding => !!e));
    } else groups.push({ items: [item], centroid: item.embedding });
  }

  return groups.map((g, idx) => {
    const ts = (i: SourceItem) => (i.publishedAt ?? i.fetchedAt).getTime();
    const ageH = (i: SourceItem) => Math.max(0, (now.getTime() - ts(i)) / 3600000);
    const citable = g.items.filter((i) => CITABLE_KINDS.includes(i.kind));
    const lead = citable[0] ?? g.items[0]!;
    const c: Cluster = {
      id: `c${idx + 1}`,
      items: g.items,
      citable,
      pillar: inferPillar(g.items.map((i) => `${i.title} ${i.summary}`).join(" "), g.items.map((i) => i.pillar)),
      headline: lead.title,
      sources: [...new Set(g.items.map((i) => i.source))],
      newestAgeHours: Math.min(...g.items.map(ageH)),
      recent6h: g.items.filter((i) => ageH(i) <= 6).length,
      recent24h: g.items.filter((i) => ageH(i) <= 24).length,
      trendTraffic: g.items.filter((i) => i.kind === "trend").reduce((s, i) => s + Number(i.metrics.traffic ?? 0), 0),
      redditScore: g.items.filter((i) => i.kind === "reddit").reduce((s, i) => s + Number(i.metrics.score ?? 0), 0),
      velocity: 0,
      embedding: g.centroid,
    };
    c.velocity = computeVelocity(c);
    return c;
  });
}
