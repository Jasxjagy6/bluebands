import pg from 'pg';
import type { QueryResult, QueryResultRow, PoolClient } from 'pg';
import { config } from './config.js';

// Return NUMERIC as string (not JS float) so money never loses precision.
pg.types.setTypeParser(1700, (v) => v);

class TreasuryPool extends pg.Pool {
  // Scanners retain a transaction while issuing RPC reads. Reserve separate
  // capacity for the shared limiter so waiting address requests cannot occupy
  // every connection needed to let those scanners finish.
  readonly rpcBudget = new pg.Pool({connectionString:config.databaseUrl,max:2,idleTimeoutMillis:30_000});

  override end():Promise<void>;
  override end(callback:()=>void):void;
  override end(callback?:()=>void):Promise<void>|void{
    const closing=Promise.all([super.end(),this.rpcBudget.end()]).then(()=>{});
    if(callback){void closing.then(callback,callback);return;}
    return closing;
  }
}

export const pool = new TreasuryPool({
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
