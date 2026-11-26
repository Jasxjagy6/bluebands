import pg from 'pg';
import type { QueryResult, QueryResultRow, PoolClient } from 'pg';
import { config } from './config.js';

// Return NUMERIC as string (not JS float) so money never loses precision.
pg.types.setTypeParser(1700, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Run fn inside a transaction; commits on success, rolls back on throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
