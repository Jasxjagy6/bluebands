import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { newServerSeed, hashSeed } from './fair.js';

export async function lockSeeds(c: PoolClient, uid: string) {
  const seed = newServerSeed();
  await c.query(`insert into user_fair(user_id,server_seed,server_seed_hash,client_seed)
    values($1,$2,$3,$4) on conflict do nothing`, [uid, seed, hashSeed(seed), randomBytes(8).toString('hex')]);
  return (await c.query<{server_seed:string; server_seed_hash:string; next_seed:string; client_seed:string; nonce:string}>(
    'select * from user_fair where user_id=$1 for update', [uid])).rows[0]!;
}

export async function takeGameSeed(c: PoolClient, uid: string) {
  const f = await lockSeeds(c, uid);
  await c.query(`update user_fair set server_seed=next_seed,server_seed_hash=$2,next_seed=$3,
    nonce=nonce+1,updated_at=now() where user_id=$1`, [uid, hashSeed(f.next_seed), newServerSeed()]);
  return f;
}
