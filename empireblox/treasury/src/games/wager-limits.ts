import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db.js';
import { formatAmount,parseAmount } from '../money.js';
import { ratePlaces,type Quote } from './prices.js';

export type Limits = {min_units:string;max_units:string|null};
const decimal=z.string().regex(/^\d{1,60}(\.\d{1,18})?$/);
export const limitsInput=z.object({min_usdt:decimal,max_usdt:decimal.nullable()}).strict().transform(b=>({
  min_units:parseAmount(b.min_usdt,18).toString(),max_units:b.max_usdt===null?null:parseAmount(b.max_usdt,18).toString(),
})).refine(b=>b.max_units===null || (BigInt(b.max_units)>0n && BigInt(b.max_units)>=BigInt(b.min_units)));

export async function readLimits(c?:PoolClient):Promise<Limits> {
  // Serialize the admission decision with a change to both limits. A missing
  // configuration row is an error, not permission to wager without limits.
  const row=(await (c??pool).query<Limits>('select min_units,max_units from wager_limits where singleton'+(c?' for share':''))).rows[0];
  if (!row) throw new Error('Bet settings unavailable');
  return row;
}
export function publicLimits(b:Limits) {
  return {min_usdt:formatAmount(BigInt(b.min_units),18),max_usdt:b.max_units===null?null:formatAmount(BigInt(b.max_units),18)};
}

type Pair=Pick<Quote,'minor_per_usd'|'usdt_per_usd'>;
type Fraction={num:bigint;den:bigint};
export function usdtValue(amount:bigint,q:Pair):Fraction {
  // Minor USDT units as an exact fraction. Never floor a value before a
  // limit comparison, even when the excess is a fraction of one ledger unit.
  const base=parseAmount(q.minor_per_usd,ratePlaces),usdt=parseAmount(q.usdt_per_usd,ratePlaces);
  if (base<=0n || usdt<=0n) throw new Error('Invalid market valuation');
  return {num:amount*10n**18n*usdt,den:base};
}
export function checkLimits(limits:Limits,stake:Fraction,prior:Fraction[]=[]):void {
  if (stake.num<BigInt(limits.min_units)*stake.den) throw new Error(`Minimum bet is ${formatAmount(BigInt(limits.min_units)*600n,18)} coins`);
  if (limits.max_units!==null) {
    // At most the blackjack opener, insurance, split, and doubles per hand.
    let {num,den}=stake;
    for (const p of prior) { num=num*p.den+p.num*den; den*=p.den; }
    if (num>BigInt(limits.max_units)*den) throw new Error(`Maximum bet is ${formatAmount(BigInt(limits.max_units)*600n,18)} coins per player per round`);
  }
}
