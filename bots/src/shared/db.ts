import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

/**
 * Minimal query interface. Satisfied by pg.Pool in production and by PGlite in tests,
 * so all data access code is testable against a real Postgres engine.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

export function createPool(databaseUrl: string): Db {
  // Supabase and most hosted Postgres require TLS; local URLs usually don't.
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  // DATE columns come back as plain YYYY-MM-DD strings instead of JS Dates shifted by the server TZ.
  pg.types.setTypeParser(1082, (v: string) => v);
  return pool as unknown as Db;
}

export async function migrate(db: Db): Promise<void> {
  if (db.exec) {
    await db.exec(SCHEMA_SQL);
    return;
  }
  // pg runs multi-statement text fine when there are no parameters
  await db.query(SCHEMA_SQL);
}

export async function kvGet(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>("SELECT value FROM kv WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function kvSet(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}
