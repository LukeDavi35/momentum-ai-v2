import type { Db } from "../db/db.js";
import { PILLARS, TEMPLATES, type Pillar, type Template } from "../config/index.js";

export const HOOK_STYLES = ["question", "stat", "contrast", "promise", "story", "news"] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];
export const LENGTH_BUCKETS = ["short", "medium", "long"] as const; // <25s, 25-40s, >40s
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/**
 * Everything the weekly learning loop is allowed to change. Multipliers are centred on 1.0
 * (1 = no opinion). Versioned in `weight_versions`, so every change can be rolled back.
 */
export interface Weights {
  /** Ideation scoring weights; always sum to 1. */
  scoring: { velocity: number; templateFit: number; novelty: number; engagement: number };
  templates: Record<Template, number>;
  pillars: Record<Pillar, number>;
  hookStyles: Record<HookStyle, number>;
  /** Posting-hour multipliers, keyed "00".."23" (local schedule timezone). */
  hours: Record<string, number>;
  lengths: Record<LengthBucket, number>;
}

const ones = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 1])) as Record<K, number>;

export function defaultWeights(): Weights {
  return {
    scoring: { velocity: 0.3, templateFit: 0.25, novelty: 0.25, engagement: 0.2 },
    templates: ones(TEMPLATES),
    pillars: ones(PILLARS),
    hookStyles: ones(HOOK_STYLES),
    hours: ones(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))),
    lengths: ones(LENGTH_BUCKETS),
  };
}

export const lengthBucket = (seconds: number): LengthBucket => (seconds < 25 ? "short" : seconds <= 40 ? "medium" : "long");

export interface WeightVersion {
  version: number;
  weights: Weights;
  reason: string;
  kind: string;
  createdAt: Date;
}

/** Fills any missing keys (e.g. after a new template is added) so old stored versions stay usable. */
export function normaliseWeights(w: Partial<Weights> | undefined): Weights {
  const d = defaultWeights();
  return {
    scoring: { ...d.scoring, ...(w?.scoring ?? {}) },
    templates: { ...d.templates, ...(w?.templates ?? {}) },
    pillars: { ...d.pillars, ...(w?.pillars ?? {}) },
    hookStyles: { ...d.hookStyles, ...(w?.hookStyles ?? {}) },
    hours: { ...d.hours, ...(w?.hours ?? {}) },
    lengths: { ...d.lengths, ...(w?.lengths ?? {}) },
  };
}

export async function ensureInitialWeights(db: Db): Promise<void> {
  const n = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM weight_versions`);
  if (Number(n.rows[0]?.n) === 0) {
    await db.query(`INSERT INTO weight_versions (weights, reason, kind) VALUES ($1::jsonb, 'initial defaults', 'initial')`, [JSON.stringify(defaultWeights())]);
  }
}

export async function getCurrentWeights(db: Db): Promise<WeightVersion> {
  await ensureInitialWeights(db);
  const res = await db.query(`SELECT * FROM weight_versions ORDER BY version DESC LIMIT 1`);
  const r = res.rows[0];
  return { version: r.version, weights: normaliseWeights(r.weights), reason: r.reason, kind: r.kind, createdAt: new Date(r.created_at) };
}

export async function listWeightVersions(db: Db, limit = 50): Promise<WeightVersion[]> {
  const res = await db.query(`SELECT * FROM weight_versions ORDER BY version DESC LIMIT $1`, [limit]);
  return res.rows.map((r) => ({ version: r.version, weights: normaliseWeights(r.weights), reason: r.reason, kind: r.kind, createdAt: new Date(r.created_at) }));
}

export async function saveWeights(db: Db, weights: Weights, reason: string, kind: "auto" | "rollback", rolledBackTo?: number): Promise<number> {
  const res = await db.query<{ version: number }>(
    `INSERT INTO weight_versions (weights, reason, kind, rolled_back_to) VALUES ($1::jsonb, $2, $3, $4) RETURNING version`,
    [JSON.stringify(weights), reason, kind, rolledBackTo ?? null],
  );
  return res.rows[0]!.version;
}

/**
 * Rollback never deletes history: it appends a NEW version whose weights equal the target's,
 * so "what was live when" stays fully auditable.
 */
export async function rollbackWeights(db: Db, toVersion: number, reason = "manual rollback"): Promise<number> {
  const res = await db.query(`SELECT weights FROM weight_versions WHERE version = $1`, [toVersion]);
  if (res.rowCount === 0) throw new Error(`No weight version ${toVersion}`);
  return saveWeights(db, normaliseWeights(res.rows[0].weights), `${reason} (restored v${toVersion})`, "rollback", toVersion);
}
