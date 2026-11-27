import type { PoolClient } from 'pg';
import { tx } from './db.js';
import { receiveAddress } from './chains/receive.js';

type Address = { address: string; chainId: string };
type Binding = { address: string; deriv_index: number };
const launch = ['BSC','ETH','POL','SOL'];

/** Admin API receives only an OAEP envelope. There is deliberately no raw-seed setter or reset. */
export async function submitCustodyEnvelope(c: PoolClient, keyId: string, sealedBase64: string): Promise<void> {
  if (typeof keyId!=='string' || typeof sealedBase64!=='string' || !/^[0-9a-f]{64}$/.test(keyId) || !/^[a-zA-Z0-9+/]{512}$/.test(sealedBase64))
    throw Object.assign(new Error('Invalid custody envelope'), {statusCode:400});
  const sealed=Buffer.from(sealedBase64,'base64');
  if (sealed.length!==384 || sealed.toString('base64')!==sealedBase64)
    throw Object.assign(new Error('Invalid custody envelope'), {statusCode:400});
  const saved=await c.query(`update custody_root set sealed_seed=$2 where key_id=$1 and sealed_seed is null
    and wrap_seen_at between clock_timestamp()-interval '2 minutes' and clock_timestamp()`,[keyId,sealed]);
  if (!saved.rowCount) throw Object.assign(new Error('Custody key unavailable or already configured'), {statusCode:409});
}

/** Called inside the registration/issuance transaction. The API handles public material only. */
export async function allocateCustodyAddresses(c: PoolClient, userId: string, requested?: string): Promise<Address[]> {
  if (requested!==undefined && !launch.includes(requested)) return [];
  const gates=await c.query(`select value from settings where key='deposits_paused' for share`);
  if(gates.rows[0]?.value!==false)return [];
  const key=(await c.query<{key_id:string;evm_xpub:string|null}>(
    'select key_id,evm_xpub from custody_root where singleton for share')).rows[0];
  if (!requested && !key?.evm_xpub) return [];

  // Same user requesting different EVM networks concurrently must share one index.
  if (!(await c.query('select id from users where id=$1 for update',[userId])).rowCount) return [];
  // Serialize with the watcher's owner snapshot / cursor commit. Signup can skip
  // a busy scanner and backfill later rather than waiting for third-party RPC.
  const locked=(await c.query<{id:string}>(`select id from chains where id=any($1::text[]) and enabled order by id for share
    ${requested?'':'skip locked'}`,[requested?[requested]:launch])).rows.map(r=>r.id);
  const routes=(await c.query<{chain_id:string;ready:boolean}>(`select chain_id,ready from custody_network_readiness
    where monitor_ready and chain_id=any($1::text[]) order by chain_id`,[locked])).rows;
  const addresses:Address[]=[];
  for (const {chain_id:chainId,ready} of routes) {
    const existing=(await c.query<{address:string;custody_kind:string}>(`select address,custody_kind from deposit_addresses
      where user_id=$1 and chain_id=$2`,[userId,chainId])).rows[0];
    // An exhausted SOL pool must not suppress an assigned address. Managed wallets
    // require a live/verified key even on reread; legacy keys have no such worker.
    if (existing) {
      if (existing.custody_kind==='legacy' || (await c.query('select 1 from custody_public_key where ready')).rowCount)
        addresses.push({address:existing.address,chainId});
      continue;
    }
    if (!ready || !key?.evm_xpub) continue;
    let binding:Binding|undefined;
    if (chainId==='SOL') {
      binding=(await c.query<Binding>(`update custody_sol_pool set user_id=$1 where key_id=$2 and deriv_index=(
        select deriv_index from custody_sol_pool where key_id=$2 and user_id is null order by deriv_index limit 1 for update skip locked
      ) returning address,deriv_index`,[userId,key.key_id])).rows[0];
      if (!binding) continue;
    } else {
      binding=(await c.query<Binding>('select address,deriv_index from custody_evm_users where user_id=$1 and key_id=$2',[userId,key.key_id])).rows[0];
      if (!binding) {
        const index=Number((await c.query("select nextval('custody_evm_index') as idx")).rows[0].idx);
        const address=receiveAddress('evm',key.evm_xpub,index);
        binding=(await c.query<Binding>(`insert into custody_evm_users(user_id,key_id,deriv_index,address)
          values($1,$2,$3,$4) returning address,deriv_index`,[userId,key.key_id,index,address])).rows[0]!;
      }
    }
    await c.query(`insert into deposit_addresses(user_id,chain_id,address,deriv_index,custody_kind,custody_key_id)
      values($1,$2,$3,$4,'managed',$5)`,[userId,chainId,binding.address,binding.deriv_index,key.key_id]);
    addresses.push({address:binding.address,chainId});
  }
  return addresses;
}

export async function getOrCreateAddress(userId: string, chainId: string): Promise<Address> {
  const [assigned]=await tx(c=>allocateCustodyAddresses(c,userId,chainId));
  if (!assigned) throw new Error('Direct deposit network unavailable');
  return assigned;
}
