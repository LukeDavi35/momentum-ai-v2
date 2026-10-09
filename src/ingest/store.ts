import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { Embedder } from "../ideate/embeddings.js";
import type { RawItem, SourceItem, SourceKind } from "./types.js";

export function contentHash(item: Pick<RawItem, "source" | "url" | "title" | "kind">, now = new Date()): string {
  // trend titles repeat day after day; key them by day so velocity can be re-measured daily
  const dayKey = item.kind === "trend" ? now.toISOString().slice(0, 10) : "";
  return createHash("sha1").update(`${item.source}|${item.url || item.title}|${dayKey}`).digest("hex");
}

function mapRow(r: any): SourceItem {
  return {
    id: r.id,
    source: r.source,
    kind: r.kind as SourceKind,
    pillar: r.pillar,
    url: r.url,
    title: r.title,
    summary: r.summary,
    bodyText: r.body_text,
    publishedAt: r.published_at ? new Date(r.published_at) : null,
    fetchedAt: new Date(r.fetched_at),
    metrics: r.metrics ?? {},
    embedding: r.embedding ?? null,
  };
}

/** Inserts new items (embedding only those), refreshes metrics on ones we already have. */
export async function storeItems(db: Db, embedder: Embedder, items: RawItem[], now = new Date()): Promise<{ inserted: number; refreshed: number }> {
  if (items.length === 0) return { inserted: 0, refreshed: 0 };
  const keyed = items.map((i) => ({ item: i, hash: contentHash(i, now) }));
  const existing = await db.query<{ content_hash: string }>(`SELECT content_hash FROM source_items WHERE content_hash = ANY($1::text[])`, [keyed.map((k) => k.hash)]);
  const have = new Set(existing.rows.map((r) => r.content_hash));
  const fresh = keyed.filter((k) => !have.has(k.hash));
  // de-dupe within the batch itself
  const uniqueFresh = [...new Map(fresh.map((k) => [k.hash, k])).values()];

  const embeddings = uniqueFresh.length ? await embedder.embed(uniqueFresh.map((k) => `${k.item.title}. ${k.item.summary}`.slice(0, 1000))) : [];
  let inserted = 0;
  for (let i = 0; i < uniqueFresh.length; i++) {
    const { item, hash } = uniqueFresh[i]!;
    const res = await db.query(
      `INSERT INTO source_items (id, source, kind, pillar, url, title, summary, body_text, published_at, content_hash, metrics, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) ON CONFLICT (content_hash) DO NOTHING`,
      [
        randomUUID(),
        item.source,
        item.kind,
        item.pillar ?? null,
        item.url ?? null,
        item.title,
        item.summary,
        item.bodyText ?? "",
        item.publishedAt?.toISOString() ?? null,
        hash,
        JSON.stringify(item.metrics ?? {}),
        JSON.stringify(embeddings[i]),
      ],
    );
    inserted += res.rowCount;
  }
  let refreshed = 0;
  for (const { item, hash } of keyed.filter((k) => have.has(k.hash) && k.item.metrics)) {
    const r = await db.query(`UPDATE source_items SET metrics = $2::jsonb, fetched_at = now() WHERE content_hash = $1`, [hash, JSON.stringify(item.metrics)]);
    refreshed += r.rowCount;
  }
  return { inserted, refreshed };
}

export async function getItemsByIds(db: Db, ids: string[]): Promise<SourceItem[]> {
  if (ids.length === 0) return [];
  const res = await db.query(`SELECT * FROM source_items WHERE id = ANY($1::uuid[])`, [ids]);
  return res.rows.map(mapRow);
}

/** Items published (or, lacking a date, fetched) within the last `hours`. */
export async function listRecentItems(db: Db, hours: number, now = new Date()): Promise<SourceItem[]> {
  const since = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const res = await db.query(`SELECT * FROM source_items WHERE COALESCE(published_at, fetched_at) >= $1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 2000`, [since]);
  return res.rows.map(mapRow);
}
