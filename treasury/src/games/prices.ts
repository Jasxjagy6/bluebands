import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { formatAmount, parseAmount } from '../money.js';

type Db = Pick<PoolClient,'query'>;
export type Quote = {id:string;asset_id:string;unit:string;quoted_at:Date;expires_at:Date;minor_per_usd:string;usdt_per_usd:string};
export const ratePlaces = 24;
const scale = 10n ** BigInt(ratePlaces), ttl = 120_000;
const coinbase = 'https://api.coinbase.com/v2/exchange-rates?currency=USD';
const kraken = 'https://api.kraken.com/0/public/Ticker?pair=TRXUSD,USDTUSD';
const live = `q.quoted_at<=clock_timestamp() and q.quoted_at>clock_timestamp()-interval '2 minutes'
  and q.expires_at>clock_timestamp() and q.usdt_per_usd is not null and q.minor_per_usd is not null`;

export class MarketUnavailable extends Error {
  constructor() { super('Market price unavailable. Try again shortly.'); }
}
function rate(value:unknown): bigint {
  if (typeof value!=='string' || !/^\d{1,16}(\.\d{1,24})?$/.test(value)) throw new MarketUnavailable();
  const n=parseAmount(value,ratePlaces);
  if (n===0n) throw new MarketUnavailable();
  return n;
}
export function quoteUnit(value:string,decimals:number) {
  return rate(value)*10n**BigInt(decimals)/(600n*scale);
}

type Book={a?:unknown;b?:unknown;c?:unknown};
function twiceMidpoint(book?:Book) {
  if (!Array.isArray(book?.a) || !Array.isArray(book.b) || !Array.isArray(book.c)) throw new MarketUnavailable();
  const bid=rate(book.b[0]),ask=rate(book.a[0]);
  rate(book.c[0]); // Validate the ticker, but price the current book rather than the last trade.
  if (bid>ask) throw new MarketUnavailable();
  return bid+ask;
}
function krakenRates(body:{error?:unknown;result?:Record<string,Book>}) {
  if (!Array.isArray(body.error) || body.error.length || !body.result || Object.keys(body.result).length!==2) throw new MarketUnavailable();
  const trx=twiceMidpoint(body.result.TRXUSD), stable=twiceMidpoint(body.result.USDTZUSD);
  // With USD midpoints T and U, (TRX/USD, USDT/USD) must be proportional
  // to (U,T). Reduce that pair, then round just ONE multiplier to 24 places.
  let g=trx,b=stable;
  while(b) [g,b]=[b,g%b];
  const target=2n*scale*scale, divisor=trx*(stable/g), factor=(target+divisor/2n)/divisor;
  const error=factor*divisor-target;
  if ((error<0n?-error:error)*10n**16n>target) throw new MarketUnavailable();
  return {TRX:formatAmount(factor*(stable/g),ratePlaces),USDT:formatAmount(factor*(trx/g),ratePlaces)};
}

// A quote uses both legs from a single provider response. Bound the snapshot
// by its HTTP Date/Age, not just the time we put it in Postgres.
async function fetchRates(endpoint:string) {
  try {
    const start=Date.now();
    const res=await fetch(endpoint,{signal:AbortSignal.timeout(5000),redirect:'error',cache:'no-store'});
    if (res.status!==200) throw new MarketUnavailable();
    const dateHeader=res.headers.get('date'),date=Date.parse(dateHeader??''),age=res.headers.get('age')??'0';
    const body=await res.json() as {data?:{currency?:unknown;rates?:Record<string,unknown>};error?:unknown;result?:Record<string,Book>};
    const received=Date.now();
    if (!Number.isFinite(date) || new Date(date).toUTCString()!==dateHeader || date>received+5000 || !/^\d{1,8}$/.test(age)) throw new MarketUnavailable();
    const observed=Math.min(start,date,received-Number(age)*1000);
    if (received-observed>=ttl) throw new MarketUnavailable();
    const rates:Record<string,unknown>|undefined=endpoint===kraken ? krakenRates(body) : body?.data?.currency==='USD' ? body.data.rates : undefined;
    if (!rates || typeof rates!=='object' || Array.isArray(rates)) throw new MarketUnavailable();
    return {rates,observed:new Date(observed)};
  } catch { throw new MarketUnavailable(); }
}
const pending=new Map<string,ReturnType<typeof fetchRates>>();

export async function marketQuote(db:Db,asset:string):Promise<Quote> {
  const a=(await db.query<{symbol:string;decimals:number}>('select symbol,decimals from playing_assets where id=$1',[asset])).rows[0];
  if (!a) throw new Error('Currency unavailable');
  // The stable cutoff can use the (asset_id, expires_at) archive index; the
  // live predicate still checks the wall clock, not transaction start time.
  const cached=(await db.query<Quote>(`select q.* from game_quotes q where q.asset_id=$1 and q.expires_at>statement_timestamp() and ${live}
    order by q.expires_at desc limit 1`,[asset])).rows[0];
  if (cached) return cached;
  const endpoint=a.symbol==='TRX'?kraken:coinbase;
  let load=pending.get(endpoint);
  if (!load) {load=fetchRates(endpoint).finally(()=>pending.delete(endpoint));pending.set(endpoint,load);}
  const {rates,observed}=await load;
  const minor=rate(rates[a.symbol])*10n**BigInt(a.decimals), usdt=rate(rates.USDT);
  const row=(await db.query<Quote>(`insert into game_quotes(asset_id,unit,minor_per_usd,usdt_per_usd,quoted_at,expires_at)
    select $1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '2 minutes'
    where $5::timestamptz<=clock_timestamp() and $5::timestamptz>clock_timestamp()-interval '2 minutes' returning *`,
    [asset,(minor/(600n*scale)).toString(),formatAmount(minor,ratePlaces),formatAmount(usdt,ratePlaces),observed])).rows[0];
  if (!row) throw new MarketUnavailable();
  return row;
}
export async function currentQuote(asset:string) {
  const q=await marketQuote(pool,asset);
  if (q.unit==='0') throw new MarketUnavailable();
  return q;
}

/** A client may select an issued catalog quote ID, never its rate or expiry. */
export async function checkedQuote(db:Db,id:string,asset:string) {
  const q=(await db.query<Quote>(`select q.* from game_quotes q join playing_assets a on a.id=q.asset_id
    where q.id=$1 and q.asset_id=$2 and q.unit>0 and ${live}`,[id,asset])).rows[0];
  if (!q) throw new Error('Price expired. Refresh the price and try again.');
  return q;
}
