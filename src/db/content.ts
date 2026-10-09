import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Pillar, Template } from "../config/index.js";
import type { Embedding } from "../ideate/embeddings.js";

export const CONTENT_STATUSES = [
  "idea",
  "scripted",
  "voiced",
  "rendered",
  "qa_passed",
  "qa_failed",
  "held",
  "scheduled",
  "published",
  "measured",
  "failed",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** The only legal moves. Anything else is a bug and throws. */
export const ALLOWED_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  idea: ["scripted", "failed"],
  scripted: ["voiced", "failed"],
  voiced: ["rendered", "failed"],
  rendered: ["qa_passed", "qa_failed", "failed"],
  qa_passed: ["scheduled", "failed"],
  // content failures regenerate from `idea` (with feedback); technical-only failures re-voice/re-render
  // from `scripted` (script is kept); exhausted attempts go to `held`
  qa_failed: ["idea", "scripted", "held"],
  // held -> idea is the ONLY way out, and it is a manual release (scripts/release.ts)
  held: ["idea"],
  scheduled: ["published", "failed"],
  published: ["measured"],
  measured: [],
  failed: ["idea"],
};

export interface IdeaScores {
  velocity: number;
  templateFit: number;
  novelty: number;
  engagement: number;
  total: number;
}

export interface Content {
  id: string;
  correlationId: string;
  status: ContentStatus;
  pillar: Pillar;
  template: Template;
  topic: string;
  hookStyle: string | null;
  idea: Record<string, any>;
  script: Record<string, any> | null;
  voice: Record<string, any> | null;
  render: Record<string, any> | null;
  qa: Record<string, any> | null;
  score: number | null;
  regenCount: number;
  qaFeedback: string | null;
  sourceItemIds: string[];
  embedding: Embedding | null;
  error: string | null;
  failedStage: string | null;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date;
}

function mapRow(r: any): Content {
  return {
    id: r.id,
    correlationId: r.correlation_id,
    status: r.status,
    pillar: r.pillar,
    template: r.template,
    topic: r.topic,
    hookStyle: r.hook_style,
    idea: r.idea ?? {},
    script: r.script,
    voice: r.voice,
    render: r.render,
    qa: r.qa,
    score: r.score,
    regenCount: r.regen_count,
    qaFeedback: r.qa_feedback,
    sourceItemIds: r.source_item_ids ?? [],
    embedding: r.embedding,
    error: r.error,
    failedStage: r.failed_stage,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    statusChangedAt: new Date(r.status_changed_at),
  };
}

export interface NewContent {
  pillar: Pillar;
  template: Template;
  topic: string;
  hookStyle?: string | null;
  idea: Record<string, any>;
  score?: number | null;
  sourceItemIds: string[];
  embedding?: Embedding | null;
  correlationId?: string;
}

export async function createContent(db: Db, n: NewContent): Promise<Content> {
  const id = randomUUID();
  const correlationId = n.correlationId ?? randomUUID();
  return db.tx(async (t) => {
    const res = await t.query(
      `INSERT INTO content (id, correlation_id, status, pillar, template, topic, hook_style, idea, score, source_item_ids, embedding)
       VALUES ($1,$2,'idea',$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb) RETURNING *`,
      [
        id,
        correlationId,
        n.pillar,
        n.template,
        n.topic,
        n.hookStyle ?? null,
        JSON.stringify(n.idea),
        n.score ?? null,
        JSON.stringify(n.sourceItemIds),
        n.embedding ? JSON.stringify(n.embedding) : null,
      ],
    );
    await t.query(
      `INSERT INTO content_events (content_id, correlation_id, from_status, to_status, stage, detail) VALUES ($1,$2,NULL,'idea','ideate','{}'::jsonb)`,
      [id, correlationId],
    );
    return mapRow(res.rows[0]);
  });
}

export async function getContent(db: Db, id: string): Promise<Content | null> {
  const res = await db.query(`SELECT * FROM content WHERE id = $1`, [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listContentByStatus(db: Db, status: ContentStatus | ContentStatus[], limit = 200): Promise<Content[]> {
  const statuses = Array.isArray(status) ? status : [status];
  const res = await db.query(`SELECT * FROM content WHERE status = ANY($1::text[]) ORDER BY created_at DESC LIMIT $2`, [statuses, limit]);
  return res.rows.map(mapRow);
}

/** Patchable columns -> SQL cast. Whitelisted so a caller can never inject a column name. */
const PATCH_COLUMNS = {
  script: "jsonb",
  voice: "jsonb",
  render: "jsonb",
  qa: "jsonb",
  idea: "jsonb",
  embedding: "jsonb",
  score: "float8",
  regen_count: "int",
  qa_feedback: "text",
  error: "text",
  failed_stage: "text",
  hook_style: "text",
  template: "text",
} as const;
export type ContentPatch = Partial<Record<keyof typeof PATCH_COLUMNS, unknown>>;

export interface TransitionOptions {
  stage: string;
  detail?: Record<string, unknown>;
}

/**
 * Compare-and-set status change. Returns the updated row, or null if the content was
 * no longer in `from` (i.e. another worker / an earlier delivery already advanced it).
 * Callers treat null as "already done" -> that is the idempotency guarantee.
 */
export async function transition(
  db: Db,
  id: string,
  from: ContentStatus,
  to: ContentStatus,
  patch: ContentPatch = {},
  opts: TransitionOptions,
): Promise<Content | null> {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new Error(`Illegal content transition ${from} -> ${to}`);
  const sets: string[] = [`status = $2`, `updated_at = now()`, `status_changed_at = now()`];
  const params: unknown[] = [id, to, from];
  for (const [col, val] of Object.entries(patch)) {
    const cast = PATCH_COLUMNS[col as keyof typeof PATCH_COLUMNS];
    if (!cast) throw new Error(`Column not patchable: ${col}`);
    params.push(cast === "jsonb" ? (val === null || val === undefined ? null : JSON.stringify(val)) : (val ?? null));
    sets.push(`${col} = $${params.length}::${cast}`);
  }
  return db.tx(async (t) => {
    const res = await t.query(`UPDATE content SET ${sets.join(", ")} WHERE id = $1 AND status = $3 RETURNING *`, params);
    if (res.rowCount === 0) return null;
    const row = mapRow(res.rows[0]);
    await t.query(
      `INSERT INTO content_events (content_id, correlation_id, from_status, to_status, stage, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, row.correlationId, from, to, opts.stage, JSON.stringify(opts.detail ?? {})],
    );
    return row;
  });
}

/** Update fields without changing status (e.g. record an error). */
export async function patchContent(db: Db, id: string, patch: ContentPatch): Promise<void> {
  const sets: string[] = [`updated_at = now()`];
  const params: unknown[] = [id];
  for (const [col, val] of Object.entries(patch)) {
    const cast = PATCH_COLUMNS[col as keyof typeof PATCH_COLUMNS];
    if (!cast) throw new Error(`Column not patchable: ${col}`);
    params.push(cast === "jsonb" ? (val === null || val === undefined ? null : JSON.stringify(val)) : (val ?? null));
    sets.push(`${col} = $${params.length}::${cast}`);
  }
  await db.query(`UPDATE content SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function logEvent(db: Db, contentId: string, correlationId: string | null, stage: string, detail: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO content_events (content_id, correlation_id, from_status, to_status, stage, detail) VALUES ($1,$2,NULL,NULL,$3,$4::jsonb)`,
    [contentId, correlationId, stage, JSON.stringify(detail)],
  );
}

export async function listEvents(db: Db, contentId: string): Promise<any[]> {
  const res = await db.query(`SELECT * FROM content_events WHERE content_id = $1 ORDER BY id`, [contentId]);
  return res.rows;
}

export async function countByStatus(db: Db): Promise<Record<string, number>> {
  const res = await db.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM content GROUP BY status`);
  const out: Record<string, number> = {};
  for (const s of CONTENT_STATUSES) out[s] = 0;
  for (const r of res.rows) out[r.status] = Number(r.n);
  return out;
}

/** Content parked in a non-terminal status for longer than `olderThanMs` — input to the reconciler. */
export async function findStuck(db: Db, statuses: ContentStatus[], olderThanMs: number): Promise<Content[]> {
  const res = await db.query(
    `SELECT * FROM content WHERE status = ANY($1::text[]) AND status_changed_at < now() - ($2 || ' milliseconds')::interval ORDER BY status_changed_at`,
    [statuses, String(olderThanMs)],
  );
  return res.rows.map(mapRow);
}

/**
 * Dead-letter path: move content to `failed` from whatever in-flight state it is in.
 * Terminal / non-job states (published, measured, held, failed, qa_failed) are left alone.
 */
export async function failContent(db: Db, id: string, stage: string, error: string): Promise<boolean> {
  const c = await getContent(db, id);
  if (!c || !ALLOWED_TRANSITIONS[c.status].includes("failed")) return false;
  const moved = await transition(db, id, c.status, "failed", { error: error.slice(0, 1000), failed_stage: stage }, { stage, detail: { deadLettered: true } });
  return moved !== null;
}
