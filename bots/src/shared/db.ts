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

export function createPool(databaseUrl: string, schema?: string): Db {
  // Supabase and most hosted Postgres require TLS; local URLs usually don't.
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Bad DB_SCHEMA "${schema}"`);
    // Every pooled connection works inside the bots' own schema, never the app's `public`.
    pool.on("connect", (client) => {
      client.query(`SET search_path TO ${schema}`).catch((e) => console.error("[db] set search_path failed", e));
    });
  }
  // DATE columns come back as plain YYYY-MM-DD strings instead of JS Dates shifted by the server TZ.
  pg.types.setTypeParser(1082, (v: string) => v);
  return pool as unknown as Db;
}

/**
 * Supabase runs its session pooler on two hostnames per region (aws-0-… and aws-1-…) and a
 * project lives on only one of them; the wrong one answers "Tenant or user not found".
 * If DATABASE_URL points at one, try it, then the other, and return the URL that logs in.
 */
export function poolerAlternates(databaseUrl: string): string[] {
  const m = /@aws-([01])-([a-z0-9-]+)\.pooler\.supabase\.com/.exec(databaseUrl);
  if (!m) return [databaseUrl];
  const other = m[1] === "0" ? "1" : "0";
  return [databaseUrl, databaseUrl.replace(`@aws-${m[1]}-${m[2]}.`, `@aws-${other}-${m[2]}.`)];
}

export async function resolveDatabaseUrl(databaseUrl: string): Promise<string> {
  const candidates = poolerAlternates(databaseUrl);
  if (candidates.length === 1) return databaseUrl;
  let lastErr: unknown;
  for (const url of candidates) {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      await client.end();
      console.log(`[db] connected via ${new URL(url).hostname}`);
      return url;
    } catch (e) {
      lastErr = e;
      await client.end().catch(() => {});
      if (!/tenant or user not found/i.test(String((e as Error).message))) throw e; // real error: don't mask it
    }
  }
  throw lastErr;
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
