// One small database layer for both real PostgreSQL (Replit, via DATABASE_URL)
// and the embedded PGlite database (tests, and local runs with no DATABASE_URL).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { seed } from "./seed.js";

export interface Tx {
  q<T = any>(sql: string, params?: any[]): Promise<T[]>;
}
export interface Db extends Tx {
  inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

const INT8 = 20, DATE = 1082, NUMERIC = 1700;
const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = fs.readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");

function pgDb(url: string): Db {
  // Cents fit easily in a JS number; dates stay as plain YYYY-MM-DD strings.
  pg.types.setTypeParser(INT8, (v) => Number(v));
  pg.types.setTypeParser(DATE, (v) => v);
  pg.types.setTypeParser(NUMERIC, (v) => Number(v));
  const local = /localhost|127\.0\.0\.1|helium|@db[:/]/.test(url) || /sslmode=disable/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: local || /sslmode=/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  return {
    kind: "postgres",
    async q(sql, params = []) {
      return (await pool.query(sql, params)).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async inTx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ q: async (sql, params = []) => (await client.query(sql, params)).rows });
        await client.query("COMMIT"); // the balance check fires here
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function liteDb(dir?: string): Db {
  const parsers = { [INT8]: (v: string) => Number(v), [DATE]: (v: string) => v, [NUMERIC]: (v: string) => Number(v) };
  const lite = new PGlite(dir);
  const opt = { parsers };
  return {
    kind: "pglite",
    async q(sql, params = []) {
      return (await lite.query(sql, params, opt)).rows as any[];
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    async inTx(fn) {
      return (await lite.transaction(async (t) => fn({ q: async (sql, params = []) => (await t.query(sql, params, opt)).rows as any[] }))) as any;
    },
    async close() {
      await lite.close();
    },
  };
}

/** Open the database, create anything missing, and load starter data. Never drops anything. */
export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  let db: Db;
  if (opts.memory) db = liteDb();
  else if (process.env.DATABASE_URL) db = pgDb(process.env.DATABASE_URL);
  else {
    const dir = path.join(here, "..", "data", "pglite");
    fs.mkdirSync(dir, { recursive: true });
    db = liteDb(dir);
  }
  await db.exec(SCHEMA_SQL);
  await db.inTx((tx) => seed(tx));
  return db;
}

/** A user-facing mistake (bad input, rule broken). Shown to the user as-is with HTTP 400. */
export class UserError extends Error {}
