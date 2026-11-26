import type { PoolClient } from 'pg';
import { post, balanceOf, type Leg } from './ledger.js';
import { checkedQuote, marketQuote, MarketUnavailable, ratePlaces } from './games/prices.js';
import { checkLimits,readLimits,usdtValue } from './games/wager-limits.js';
import { parseAmount } from './money.js';

const HOUSE = 'house:bank';

export class InsufficientFunds extends Error {
  constructor() { super('Insufficient balance'); this.name = 'InsufficientFunds'; }
}

/**
 * Take a stake from the user into the house bank. Checks the locked balance
 * first for a clean error, and the DB CHECK is the hard backstop. Limits,
 * locked quote, journal, and its frozen valuation commit or roll back together.
 */
export async function debitStake(c: PoolClient, userId: string, assetId: string, amount: bigint, game: string, ref: string,
  options:{quote?:string;previous?:bigint}={}) {
  if (amount <= 0n) throw new Error('Stake must be positive');
  let currency=assetId, scale=1n;
  // An in-flight hand or battle may still use the original network's units.
  if (assetId.startsWith('USDT.')) {
    const route = (await c.query("select decimals from assets where id=$1 and kind='token' and symbol='USDT'", [assetId])).rows[0];
    if (!route) throw new Error('Unknown currency');
    currency='USDT';scale=10n**BigInt(18-route.decimals);
  }
  const units=amount*scale;
  if (await balanceOf(c,'u:'+userId,currency,true)<units) throw new InsufficientFunds();
  const q=options.quote ? await checkedQuote(c,options.quote,currency) : await marketQuote(c,currency);
  const limits=await readLimits(c), prior:ReturnType<typeof usdtValue>[]=[];
  if (options.previous && limits.max_units!==null) {
    let uncovered=options.previous*scale;
    const debits=await c.query<{amount:string;minor_per_usd:string;usdt_per_usd:string}>(`select amount,minor_per_usd,usdt_per_usd
      from valued_debits where user_id=$1 and game=$2 and round_id=$3`,[userId,game,ref]);
    for (const d of debits.rows) { uncovered-=BigInt(d.amount);prior.push(usdtValue(BigInt(d.amount),d)); }
    // A legacy USDT debit needs only denomination scaling. Never guess a
    // historical native cross rate to authorize more risk on an old hand.
    if (uncovered<0n || (uncovered>0n && currency!=='USDT')) throw new Error('Earlier stake has no verified USDT value. Finish this hand without adding a bet.');
    if (uncovered>0n) prior.push({num:uncovered,den:1n});
  }
  checkLimits(limits,usdtValue(units,q),prior);
  const legs:Leg[]=[{account:'u:'+userId,asset:currency,delta:-units},{account:HOUSE,asset:assetId,delta:amount}];
  if (currency!==assetId) legs.push({account:'bridge:USDT',asset:currency,delta:units},{account:'bridge:USDT',asset:assetId,delta:-amount});
  let journal:string;
  try {
    journal=await post(c,'bet:'+game,ref,legs);
  } catch (e) {
    if (/balances_user_nonneg/.test((e as Error).message)) throw new InsufficientFunds();
    throw e;
  }
  // post() may have waited for balance locks. Transaction now() would still
  // report the opening time, so check the wall clock at actual acceptance.
  const booked=await c.query(`insert into wager_debits(journal_id,user_id,game,round_id,amount,quote_id)
    select $1,$2,$3,$4,$5,q.id from game_quotes q join playing_assets a on a.id=q.asset_id
    where q.id=$6 and q.expires_at>clock_timestamp()`,[journal,userId,game,ref,units.toString(),q.id]);
  if (!booked.rowCount) throw new MarketUnavailable();
  return {minor_per_usd:q.minor_per_usd,catalogXp:units*600n*10n**BigInt(ratePlaces)/parseAmount(q.minor_per_usd,ratePlaces)};
}

/** Pay a win from the house bank back to the user. Call inside a transaction. */
export async function creditPayout(c: PoolClient, userId: string, assetId: string, amount: bigint, game: string, ref: string): Promise<void> {
  if (amount < 0n) throw new Error('Payout must be non-negative');
  if (amount === 0n) return;
  await post(c, `payout:${game}`, ref, [
    { account: HOUSE, asset: assetId, delta: -amount },
    { account: `u:${userId}`, asset: assetId, delta: amount },
  ]);
}
