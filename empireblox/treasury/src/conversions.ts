import { randomUUID } from 'node:crypto';
import { pool,tx } from './db.js';
import { lockActivePlayer } from './auth-user.js';
import { balanceOf,post } from './ledger.js';
import { formatAmount,parseAmount } from './money.js';
import { COINS,COIN_DECIMALS,COIN_BASE } from './coins.js';
import { marketQuote,ratePlaces } from './games/prices.js';

export type Direction='crypto_to_coins'|'coins_to_crypto';
export class ConversionError extends Error {
  constructor(message:string,readonly statusCode=400){super(message);}
}
type Quote={id:string;user_id:string;asset_id:string;direction:Direction;crypto_amount:string;coin_amount:string;input_amount:string;
  expires_at:Date;created_at:Date;symbol:string;decimals:number};
const quoteColumns='q.*,a.symbol,a.decimals';
function view(q:Quote){
  return {id:q.id,asset_id:q.asset_id,symbol:q.symbol,direction:q.direction,
    crypto_amount:formatAmount(BigInt(q.crypto_amount),q.decimals),coin_amount:formatAmount(BigInt(q.coin_amount),COIN_DECIMALS),
    crypto_units:q.crypto_amount,coin_units:q.coin_amount,expires_at:q.expires_at,created_at:q.created_at,
    coins_per_usdt:'600',fee:'0',rounding:'down'};
}

/** No client-provided price, target amount, expiry or balance is ever accepted. */
export async function quoteConversion(uid:string,asset:string,direction:Direction,amount:string){
  const a=(await pool.query('select id,symbol,decimals from wallet_assets where id=$1',[asset])).rows[0];
  if(!a)throw new ConversionError('Choose an available crypto balance');
  const input=parseAmount(amount,direction==='crypto_to_coins'?a.decimals:COIN_DECIMALS);
  if(input<=0n)throw new ConversionError('Enter a positive amount');
  let num=COIN_BASE,den=10n**18n,market:string|null=null,expiry=Date.now()+30_000;
  if(asset!=='USDT'){
    const q=await marketQuote(pool,asset);
    num=COIN_BASE*parseAmount(q.usdt_per_usd,ratePlaces);den=parseAmount(q.minor_per_usd,ratePlaces);
    market=q.id;expiry=Math.min(expiry,new Date(q.expires_at).getTime());
  }
  const crypto=direction==='crypto_to_coins'?input:input*den/num;
  const coins=direction==='coins_to_crypto'?input:input*num/den;
  if(crypto<=0n||coins<=0n)throw new ConversionError('Amount is too small to convert in this currency');
  if(crypto.toString().length>78||coins.toString().length>78)throw new ConversionError('Amount is too large');
  return tx(async c=>{
    await lockActivePlayer(c,uid);
    const hits=await c.query("select count(*)::int as n from conversion_quotes where user_id=$1 and created_at>clock_timestamp()-interval '1 minute'",[uid]);
    if(hits.rows[0].n>=30)throw new ConversionError('Too many quotes. Try again in a minute.',429);
    const source=direction==='crypto_to_coins'?asset:COINS;
    if(input>await balanceOf(c,'u:'+uid,source))throw new ConversionError('Insufficient available balance');
    const q=(await c.query<Quote>(`with issued as (
      insert into conversion_quotes(user_id,asset_id,direction,input_amount,crypto_amount,coin_amount,market_quote_id,rate_num,rate_den,expires_at)
      select $1,$2,$3,$4,$5,$6,$7,$8,$9,least($10::timestamptz,clock_timestamp()+interval '30 seconds')
      where $10::timestamptz>clock_timestamp()+interval '1 second' returning *)
      select issued.*,a.symbol,a.decimals from issued join assets a on a.id=issued.asset_id`,
      [uid,asset,direction,input.toString(),crypto.toString(),coins.toString(),market,num.toString(),den.toString(),new Date(expiry)])).rows[0];
    if(!q)throw new ConversionError('Price expired. Request a fresh quote.',409);
    return view(q);
  });
}

export async function convert(uid:string,request:string,quote:string){
  return tx(async c=>{
    // Same lock as wagers/withdrawals/account restrictions, before any money.
    await lockActivePlayer(c,uid);
    const prior=(await c.query(`select w.id as conversion_id,w.quote_id,w.journal_id,${quoteColumns}
      from wallet_conversions w join conversion_quotes q on q.id=w.quote_id join assets a on a.id=q.asset_id
      where w.user_id=$1 and w.request=$2`,[uid,request])).rows[0];
    if(prior){
      if(prior.quote_id!==quote)throw new ConversionError('Request already used for a different conversion',409);
      return {conversion_id:prior.conversion_id,journal_id:prior.journal_id,quote:view(prior),replayed:true};
    }
    const q=(await c.query<Quote>(`select ${quoteColumns} from conversion_quotes q join wallet_assets a on a.id=q.asset_id
      where q.id=$1 and q.user_id=$2 and q.expires_at>clock_timestamp() for update of q`,[quote,uid])).rows[0];
    if(!q)throw new ConversionError('Price expired or unavailable. Request a fresh quote.',409);
    if((await c.query('select 1 from wallet_conversions where quote_id=$1',[quote])).rowCount)
      throw new ConversionError('This quote has already been converted. Check your conversion history.',409);
    const crypto=BigInt(q.crypto_amount),coins=BigInt(q.coin_amount),toCoins=q.direction==='crypto_to_coins';
    if(await balanceOf(c,'u:'+uid,toCoins?q.asset_id:COINS,true)<(toCoins?crypto:coins))
      throw new ConversionError('Insufficient available balance');
    const id=randomUUID(),sign=toCoins?1n:-1n;
    const journal=await post(c,'conversion:'+q.direction,id,[
      {account:'u:'+uid,asset:q.asset_id,delta:-sign*crypto},{account:'house:conversion',asset:q.asset_id,delta:sign*crypto},
      {account:'house:conversion',asset:COINS,delta:-sign*coins},{account:'u:'+uid,asset:COINS,delta:sign*coins}
    ]);
    // A wait for balance/house locks cannot turn an expired quote into a trade.
    const valid=await c.query('select 1 from conversion_quotes where id=$1 and expires_at>clock_timestamp()',[quote]);
    if(!valid.rowCount)throw new ConversionError('Price expired. Request a fresh quote.',409);
    await c.query('insert into wallet_conversions(id,user_id,request,quote_id,journal_id) values($1,$2,$3,$4,$5)',[id,uid,request,quote,journal]);
    await c.query("select notify_player($1,'conversion.completed',$2,$3,$4)",[uid,id,toCoins?COINS:q.asset_id,(toCoins?coins:crypto).toString()]);
    return {conversion_id:id,journal_id:journal,quote:view(q),replayed:false};
  });
}

export async function conversionHistory(uid:string,page=0){
  const rows=(await pool.query(`select w.id as conversion_id,w.journal_id,w.created_at as converted_at,${quoteColumns}
    from wallet_conversions w join conversion_quotes q on q.id=w.quote_id join assets a on a.id=q.asset_id
    where w.user_id=$1 order by w.created_at desc,w.id limit 21 offset $2`,[uid,page*20])).rows;
  return {rows:rows.slice(0,20).map(q=>({conversion_id:q.conversion_id,journal_id:q.journal_id,converted_at:q.converted_at,quote:view(q)})),more:rows.length>20};
}
