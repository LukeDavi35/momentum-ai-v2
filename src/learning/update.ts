import type { Weights } from "../ideate/weights.js";
import { groupMean, shrink, type PerfRow } from "./performance.js";

export interface WeightChange {
  dimension: string;
  key: string;
  from: number;
  to: number;
  n: number;
  meanScore: number;
}

export interface UpdateOptions {
  /** Below this many measured posts nothing changes (not enough signal to learn from). */
  minRows?: number;
  /** Learning rate on the shrunk mean score. */
  eta?: number;
  /** Max relative move of any single multiplier per update (0.25 = ±25%). */
  maxStep?: number;
  shrinkK?: number;
  bounds?: [number, number];
}

export interface UpdateResult {
  weights: Weights;
  changes: WeightChange[];
  skipped?: string;
  rows: number;
}

const DEFAULTS = { minRows: 6, eta: 0.15, maxStep: 0.25, shrinkK: 5, bounds: [0.4, 2.5] as [number, number] };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type MultDim = "templates" | "pillars" | "hookStyles" | "hours" | "lengths";
const DIMS: Array<{ dim: MultDim; key: (r: PerfRow) => string | null }> = [
  { dim: "templates", key: (r) => r.template },
  { dim: "pillars", key: (r) => r.pillar },
  { dim: "hookStyles", key: (r) => r.hookStyle },
  { dim: "hours", key: (r) => r.hour },
  { dim: "lengths", key: (r) => r.lengthBucket },
];

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/**
 * Multiplicative-weights update, deliberately conservative:
 *   new = clamp(old · exp(η · shrunkMeanScore), old·(1±maxStep)), then bounded to [0.4, 2.5]
 * and each dimension re-centred to mean 1 so "everything did well" can't inflate every prior.
 * Small samples are shrunk toward 0 (n/(n+k)) so one lucky post can't swing the strategy.
 * Pure + deterministic: the same rows always produce the same weights.
 */
export function computeNewWeights(current: Weights, scoredRows: PerfRow[], options: UpdateOptions = {}): UpdateResult {
  const o = { ...DEFAULTS, ...options };
  const rows = scoredRows.filter((r) => r.score !== undefined);
  if (rows.length < o.minRows) return { weights: current, changes: [], skipped: `only ${rows.length} measured posts (need ≥ ${o.minRows}); weights unchanged`, rows: rows.length };

  const next: Weights = JSON.parse(JSON.stringify(current));
  const changes: WeightChange[] = [];

  for (const { dim, key } of DIMS) {
    const table = next[dim] as Record<string, number>;
    const before = { ...(current[dim] as Record<string, number>) };
    const groups = new Map(groupMean(rows, key).map((g) => [g.key, g]));
    for (const [k, g] of groups) {
      if (!(k in table)) continue;
      const old = before[k]!;
      const target = old * Math.exp(o.eta * shrink(g.mean, g.n, o.shrinkK));
      table[k] = clamp(clamp(target, old * (1 - o.maxStep), old * (1 + o.maxStep)), o.bounds[0], o.bounds[1]);
    }
    const keys = Object.keys(table);
    const mean = keys.reduce((s, k) => s + table[k]!, 0) / keys.length;
    for (const k of keys) table[k] = r3(table[k]! / mean);
    for (const k of keys) {
      if (Math.abs(table[k]! - before[k]!) > 0.005) changes.push({ dimension: dim, key: k, from: r3(before[k]!), to: table[k]!, n: groups.get(k)?.n ?? 0, meanScore: r3(groups.get(k)?.mean ?? 0) });
    }
  }

  // ideation scoring weights: nudge toward the features that actually predicted performance
  const withScores = rows.filter((r) => r.ideaScores);
  if (withScores.length >= 12) {
    const feats = ["velocity", "templateFit", "novelty", "engagement"] as const;
    const ys = withScores.map((r) => r.score!);
    const raw: Record<string, number> = {};
    for (const f of feats) {
      const r = pearson(withScores.map((x) => Number(x.ideaScores?.[f] ?? 0)), ys);
      const old = current.scoring[f];
      raw[f] = clamp(old * Math.exp(0.5 * r * (withScores.length / (withScores.length + 10))), old * 0.8, old * 1.2);
      raw[f] = Math.max(0.05, raw[f]!);
    }
    const sum = feats.reduce((s, f) => s + raw[f]!, 0);
    for (const f of feats) {
      next.scoring[f] = r3(raw[f]! / sum);
      if (Math.abs(next.scoring[f] - current.scoring[f]) > 0.005) changes.push({ dimension: "scoring", key: f, from: r3(current.scoring[f]), to: next.scoring[f], n: withScores.length, meanScore: 0 });
    }
  }
  return { weights: next, changes, rows: rows.length };
}
