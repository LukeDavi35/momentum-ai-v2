import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS } from "./migrations.js";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement SQL with no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction; commits on resolve, rolls back on throw. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pg" | "pglite";
}

// --- node-postgres adapter -------------------------------------------------

// bigint (COUNT etc.) comes back as string by default; our counts are small.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
// numeric -> number (money/score columns are well within double precision)
pg.types.setTypeParser(1700, (v) => parseFloat(v));

class PgDb implements Db {
  readonly kind = "pg" as const;
  constructor(private readonly target: pg.Pool | pg.PoolClient, private readonly owner?: pg.Pool) {}

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.target.query(sql, params as any[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.target.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!(this.target instanceof pg.Pool)) return fn(this); // already inside a tx
    const client = await this.target.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgDb(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.owner) await this.owner.end();
    else if (this.target instanceof pg.Pool) await this.target.end();
  }
}

// --- PGlite adapter (tests + local dry-run) --------------------------------

type PgliteLike = Pick<PGlite, "query" | "exec">;

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private readonly target: PgliteLike, private readonly root?: PGlite) {}

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.target.query<T>(sql, params as any[]);
    // PGlite reports affectedRows: 0 for SELECTs, so take the larger of the two
    return { rows: res.rows, rowCount: Math.max(res.affectedRows ?? 0, res.rows.length) };
  }

  async exec(sql: string): Promise<void> {
    await this.target.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this); // already inside a tx
    return this.root.transaction(async (t) => fn(new PgliteDb(t as unknown as PgliteLike)));
  }

  async close(): Promise<void> {
    await this.root?.close();
  }
}

export async function runMigrations(db: Db): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = await db.query<{ version: number }>(`SELECT version FROM schema_migrations`);
  const applied = new Set(done.rows.map((r) => r.version));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query(`INSERT INTO schema_migrations(version) VALUES ($1)`, [m.version]);
    });
    count++;
  }
  return count;
}

export async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = new PgDb(pool);
  await runMigrations(db);
  return db;
}

/** In-memory when dir is undefined, otherwise persisted under dir. */
export async function openPglite(dir?: string): Promise<Db> {
  let client: PGlite;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    client = new PGlite(join(dir, "pglite"));
  } else {
    client = new PGlite();
  }
  await client.waitReady;
  const db = new PgliteDb(client, client);
  await runMigrations(db);
  return db;
}

export async function openDb(opts: { databaseUrl?: string; dataDir: string }): Promise<Db> {
  return opts.databaseUrl ? openPostgres(opts.databaseUrl) : openPglite(opts.dataDir);
}
