import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // Hosted databases like Neon put sslmode=require in the URL, which pg handles itself.
    ssl: config.databaseSsl && !/sslmode=/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}

/** Run a function inside a transaction. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Apply any .sql files in /migrations that haven't been applied yet, in name order. */
export async function migrate(pool, log = () => {}) {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
    await tx(pool, async c => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    log(`Applied migration ${f}`);
  }
}
