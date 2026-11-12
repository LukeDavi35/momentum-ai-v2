import type { Db } from "../db/db.js";
import { clipKey, type FootageRef } from "./types.js";

/** Remembers every clip we used, so the daily video doesn't reuse a clip within the cooldown and the licence trail is auditable. */
export async function recordUse(db: Db, ref: FootageRef, contentId: string | null, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO footage_clips (provider, external_id, title, page_url, license, license_label, author, local_path, duration_s, width, height, use_count, last_used_at, last_content_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13)
     ON CONFLICT (provider, external_id) DO UPDATE SET use_count = footage_clips.use_count + 1, last_used_at = EXCLUDED.last_used_at, last_content_id = EXCLUDED.last_content_id, local_path = EXCLUDED.local_path`,
    [ref.provider, ref.externalId, ref.title, ref.pageUrl, ref.license, ref.licenseLabel, ref.author, ref.localPath, ref.durationS, ref.width, ref.height, now.toISOString(), contentId],
  );
}

/** Keys ("provider:externalId") of clips used within the last `days` days. */
export async function recentlyUsed(db: Db, days: number, now: Date): Promise<Set<string>> {
  if (days <= 0) return new Set();
  const res = await db.query<{ provider: string; external_id: string }>(`SELECT provider, external_id FROM footage_clips WHERE last_used_at > $1`, [new Date(now.getTime() - days * 86400_000).toISOString()]);
  return new Set(res.rows.map((r) => clipKey({ provider: r.provider as FootageRef["provider"], externalId: r.external_id })));
}
