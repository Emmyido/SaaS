import pg from "pg";
import { config } from "../config.js";

// BIGINT columns hold money in kobo (minor units). Values stay well inside
// Number.MAX_SAFE_INTEGER (~90 trillion naira), so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings to avoid timezone shifts.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = Pick<pg.PoolClient, "query">;

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await db.query(text, params);
  return res.rows[0] as T | undefined;
}

export async function many<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows as T[];
}
