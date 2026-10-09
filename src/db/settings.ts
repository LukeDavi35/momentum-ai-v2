import type { Db } from "./db.js";

export async function getSetting<T = unknown>(db: Db, key: string): Promise<T | undefined> {
  const res = await db.query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return res.rows[0]?.value;
}

export async function setSetting(db: Db, key: string, value: unknown, by = "system"): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by],
  );
}
