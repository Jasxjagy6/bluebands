import type { PoolClient } from 'pg';
import { query } from './db.js';

export type Leg = { account: string; asset: string; delta: bigint };

/**
 * The one money-movement primitive. Writes an immutable journal + its entries
 * AND updates the locked balances table, in the caller's transaction.
 *  - legs must net to zero per asset (double-entry).
 *  - balance rows are locked in a stable order (no deadlocks).
 *  - a user account ('u:*') going negative hits a DB CHECK and throws, so an
 *    overdraft can never be committed. Catch and treat as "insufficient funds".
 */
export async function post(c: PoolClient, kind: string, ref: string | null, legs: Leg[]): Promise<string> {
  const sums = new Map<string, bigint>();
  for (const l of legs) sums.set(l.asset, (sums.get(l.asset) ?? 0n) + l.delta);
  for (const [, v] of sums) if (v !== 0n) throw new Error('unbalanced journal');

  const j = await c.query<{ id: string }>(`insert into journals(kind, ref) values ($1,$2) returning id`, [kind, ref]);
  const journalId = j.rows[0]!.id;

  const keys = [...new Set(legs.map((l) => `${l.account}\u0000${l.asset}`))].sort();
  for (const k of keys) {
    const [account, asset] = k.split('\u0000') as [string, string];
    await c.query(`insert into balances(account, asset_id, amount) values ($1,$2,0) on conflict do nothing`, [account, asset]);
    await c.query(`select 1 from balances where account=$1 and asset_id=$2 for update`, [account, asset]);
  }
  for (const l of legs) {
    await c.query(`insert into ledger_entries(journal_id, account, asset_id, delta) values ($1,$2,$3,$4)`, [journalId, l.account, l.asset, l.delta.toString()]);
    await c.query(`update balances set amount = amount + $3 where account=$1 and asset_id=$2`, [l.account, l.asset, l.delta.toString()]);
  }
  return journalId;
}

/** Balance of one account+asset, optionally row-locked for a check-then-spend. */
export async function balanceOf(c: PoolClient, account: string, assetId: string, lock = false): Promise<bigint> {
  const r = await c.query<{ amount: string }>(
    `select amount::text from balances where account=$1 and asset_id=$2 ${lock ? 'for update' : ''}`,
    [account, assetId],
  );
  return BigInt(r.rows[0]?.amount ?? '0');
}

/**
 * Credit a confirmed deposit into spendable balance — exactly once.
 * (Locks the deposit row and flips its status in the same transaction.)
 */
export async function creditConfirmedDeposit(c: PoolClient, depositId: string): Promise<boolean> {
  const r = await c.query<{ id: string; user_id: string; chain_id: string; asset_id: string; amount: string; status: string }>(
    `select id, user_id, chain_id, asset_id, amount, status from deposits where id=$1 and not review_hold and journal_id is null and status='confirmed' and confirmations >= required_conf for update`,
    [depositId],
  );
  const d = r.rows[0];
  if (!d) return false;
  const amt = BigInt(d.amount);
  const source=(await c.query('select symbol,kind,decimals from assets where id=$1',[d.asset_id])).rows[0];
  const legs:Leg[]=[{account:'ext:'+d.chain_id,asset:d.asset_id,delta:-amt}];
  if(source.kind==='token' && source.symbol==='USDT'){
    const units=amt*10n**BigInt(18-source.decimals);
    legs.push({account:'bridge:USDT',asset:d.asset_id,delta:amt},{account:'bridge:USDT',asset:'USDT',delta:-units},
      {account:'u:'+d.user_id,asset:'USDT',delta:units});
  }else legs.push({account:'u:'+d.user_id,asset:d.asset_id,delta:amt});
  const journalId=await post(c,'deposit',`deposit:${d.id}`,legs);
  await c.query(`update deposits set status='credited', journal_id=$2, credited_at=now() where id=$1`, [d.id, journalId]);
  return true;
}

export async function getUserBalances(userId: string): Promise<{ asset_id: string; amount: string }[]> {
  const r = await query<{ asset_id: string; amount: string }>(
    `select b.asset_id, b.amount::text, a.symbol, a.chain_id, a.decimals, a.kind from balances b join assets a on a.id=b.asset_id where account=$1 and amount <> 0 order by b.asset_id`,
    [`u:${userId}`],
  );
  return r.rows;
}
