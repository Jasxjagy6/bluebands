import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { base58 } from '@scure/base';
import { lockActivePlayer } from './auth-user.js';
import { config } from './config.js';
import { query, tx } from './db.js';
import { post } from './ledger.js';
import { formatAmount, parseAmount } from './money.js';
import { getSecret } from './vault.js';

const merchant = 'oxapay:merchant';
const tracking = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
type Fields = Record<string, unknown>;
type Status = 'creating'|'waiting'|'paying'|'underpaid'|'review'|'expired'|'failed'|'credited';
type Invoice = {
  id:string; user_id:string; asset_id:string; symbol:string; decimals:number; amount:string; public_origin:string;
  status:Status; review_reason:string|null; networks:string[]; network_aliases:Record<string,string>;
  dispatched_at:Date|null; track_id:string|null; payment_url:string|null; expires_at:Date|null; created_at:Date;
  credited_at:Date|null; pending_at:Date|null; history_page:number; probe_seq:string; applied_seq:string;
};
type Transfer = {chain_id:string; txid:string; amount:string; address:string};
export type InvoiceRequest = {asset:string; amount:string; request:string};
export class InvoiceError extends Error {
  constructor(readonly statusCode:number, message:string) { super(message); }
}
class Rejected extends Error {} // Only a definitive v1 rejection, not a transport/parse failure.

function obj(value:unknown): Fields {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Fields : {};
}
function text(value:unknown):string { return typeof value==='string' ? value : ''; }

// v1 uses JSON *numbers* for money. Preserve the wire lexeme, including scientific
// notation and the 18th decimal place, rather than trusting JSON.parse's doubles.
function exactJson(raw:string):Fields {
  JSON.parse(raw); // Validate the original grammar before quoting number tokens.
  return obj(JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?/g,
    token => token[0]==='"' ? token : '"'+token+'"')));
}
function units(value:unknown, decimals:number):bigint|null {
  const m=/^(\d{1,78})(?:\.(\d{1,78}))?(?:[Ee]([+-]?\d{1,3}))?$/.exec(text(value));
  if(!m)return null;
  const fraction=m[2]??'', scale=decimals+Number(m[3]??0)-fraction.length;
  if(Math.abs(scale)>156)return null;
  const n=BigInt(m[1]+fraction), factor=10n**BigInt(Math.abs(scale));
  if(scale<0 && n%factor!==0n)return null;
  const result=scale<0 ? n/factor : n*factor;
  return result.toString().length<=78 ? result : null;
}
function requestedUnits(amount:string, decimals:number):bigint {
  try {
    if(amount.length>78)throw new Error();
    const n=parseAmount(amount,decimals);
    if(n>0n && n.toString().length<=78)return n;
  } catch {}
  throw new InvoiceError(400,`Enter a positive amount with at most ${decimals} decimal places`);
}
function origin():string {
  try {
    const u=new URL(config.publicOrigin);
    if(u.protocol==='https:' && u.origin===config.publicOrigin)return u.origin;
  } catch {}
  throw new InvoiceError(503,'Hosted deposits are not configured');
}
function checkout(value:unknown):string|null {
  const s=text(value);
  if(!s || s.length>1024 || /[\s\\?#]/.test(s))return null;
  try {
    const u=new URL(s);
    if(u.protocol!=='https:' || u.username || u.password || u.port || u.search || u.hash)return null;
    // The provider's checkout token is opaque, not a documented encoding of track_id.
    if((u.hostname==='pay.oxapay.com' && /^\/[\w-]+\/?$/.test(u.pathname)) ||
       (u.hostname==='oxapay.com' && /^\/pay\/[\w-]+\/?$/.test(u.pathname)))return u.href;
  } catch {}
  return null;
}
function expiry(value:unknown):Date|null {
  const s=text(value);
  return /^\d{10}$/.test(s) ? new Date(Number(s)*1000) : null;
}
export function publicInvoice(i:Invoice) {
  return {id:i.id,asset_id:i.asset_id,symbol:i.symbol,decimals:i.decimals,amount:i.amount,status:i.status,
    networks:i.networks,payment_url:i.status==='waiting' && i.expires_at && i.expires_at.getTime()>Date.now() ? checkout(i.payment_url) : null,
    expires_at:i.expires_at,created_at:i.created_at,credited_at:i.credited_at};
}

// A hosted network is a provider custody route, not a requirement to enable a
// direct-chain watcher. Only match names from the currency's frozen catalog.
const chainNames:Record<string,string>={ETH:'ETH',ERC20:'ETH',ETHEREUM:'ETH',ETHEREUMNETWORK:'ETH',
  BSC:'BSC',BEP20:'BSC',BNBSMARTCHAIN:'BSC',BINANCESMARTCHAIN:'BSC',POLYGON:'POL',POLYGONNETWORK:'POL',
  TRON:'TRON',TRC20:'TRON',TRONNETWORK:'TRON',BTC:'BTC',BITCOIN:'BTC',BITCOINNETWORK:'BTC',SOL:'SOL',SOLANA:'SOL',SOLANANETWORK:'SOL',SPL:'SOL'};
function networkName(value:unknown):string {
  const s=text(value).trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9 ()_.+-]{0,79}$/.test(s) ? s : '';
}
function chainCode(s:string):string|undefined {return chainNames[s.replace(/[^A-Z0-9]/g,'')];}
function networkSnapshot(catalog:Fields,symbol:string,amount:bigint,decimals:number) {
  const coin=obj(catalog[symbol]), aliases:Record<string,string>=Object.create(null);
  if(text(coin.symbol).toUpperCase()!==symbol || coin.status!==true)throw new InvoiceError(400,'This currency is unavailable at checkout');
  for(const [key,entry] of Object.entries(obj(coin.networks))){
    const n=obj(entry), code=networkName(n.network), labels=[code,networkName(n.name),networkName(key)].filter(Boolean);
    const min=units(n.deposit_min,decimals);
    if(!code || min===null || amount<min)continue;
    const known=[...new Set(labels.map(chainCode).filter((v):v is string=>v!==undefined))];
    if(known.length>1)throw new Error('Ambiguous provider network');
    const chain=known[0]??code;
    for(const label of [...labels,chain]){
      if(aliases[label] && aliases[label]!==chain)throw new Error('Ambiguous provider network');
      aliases[label]=chain;
    }
  }
  const networks=[...new Set(Object.values(aliases))].sort();
  if(!networks.length)throw new InvoiceError(400,'No checkout network accepts this deposit amount');
  return {networks,aliases};
}

function transfers(info:Fields, i:Invoice):Transfer[]|string {
  if(!Array.isArray(info.txs) || !info.txs.length || info.txs.length>128)return 'missing_transfers';
  const result:Transfer[]=[], seen=new Set<string>();
  let total=0n;
  for(const value of info.txs){
    const t=obj(value), label=networkName(t.network), chain=Object.hasOwn(i.network_aliases,label)?i.network_aliases[label]:undefined;
    if(!chain || !i.networks.includes(chain))return 'unexpected_network';
    if(text(t.currency).toUpperCase()!==i.symbol)return 'unexpected_payment_currency';
    if(text(t.status).toLowerCase()!=='confirmed')return 'unconfirmed_transfer';
    const address=text(t.address), hash=text(t.tx_hash);
    if(!/^[\x21-\x7e]{1,200}$/.test(address) || !/^[A-Za-z0-9:_-]{12,180}$/.test(hash))return 'invalid_transfer_identity';
    let txid=hash;
    if(['ETH','BSC','POL'].includes(chain)){
      if(!/^(?:0x)?[\da-f]{64}$/i.test(hash))return 'invalid_transfer_identity';
      txid='0x'+hash.replace(/^0x/i,'').toLowerCase();
    } else if(chain==='BTC' || chain==='TRON'){
      if(!/^[\da-f]{64}$/i.test(hash))return 'invalid_transfer_identity';
      txid=hash.toLowerCase();
    } else if(chain==='SOL'){
      try{if(base58.decode(hash).length!==64)return 'invalid_transfer_identity';}catch{return 'invalid_transfer_identity';}
    } else if(/^0x[\da-f]{64}$/i.test(hash))txid=hash.toLowerCase();
    const identity=chain+':'+txid;
    if(seen.has(identity))return 'duplicate_transfer';
    seen.add(identity);
    // Payment Information documents tx.amount; v1 IPN also names gross/net
    // sent_amount/received_amount. Never cover a short net receipt with gross.
    if(t.amount==null && t.received_amount==null)return 'missing_received_amount';
    let received:bigint|null=null;
    for(const field of [t.amount,t.received_amount,t.sent_amount]){
      if(field==null)continue;
      const n=units(field,i.decimals);
      if(n===null || n<=0n)return 'invalid_transfer_amount';
      if(received===null || n<received)received=n;
    }
    total+=received!;
    result.push({chain_id:chain,txid,amount:received!.toString(),address});
  }
  return total>=BigInt(i.amount) ? result : 'short_payment';
}
async function issuanceGate(c:PoolClient) {
  const settings=(await c.query("select key,value from settings where key in ('deposit_provider','deposits_paused') order by key for share")).rows;
  if(settings.find(s=>s.key==='deposits_paused')?.value!==false)throw new InvoiceError(503,'Deposits are temporarily paused');
  if(settings.find(s=>s.key==='deposit_provider')?.value!=='oxapay')throw new InvoiceError(503,'Hosted deposits are unavailable');
}
async function recordState(c:PoolClient,i:Invoice,status:Status,reason:string|null,seq=i.applied_seq) {
  if(i.status==='credited')return;
  const delay=({creating:60,waiting:60,paying:30,underpaid:300,review:3600,expired:null,failed:null,credited:null})[status];
  await c.query(`update oxapay_invoices set status=$2,review_reason=$3,applied_seq=$4,
    next_check_at=now()+$5::int*interval '1 second',updated_at=case when (status,review_reason) is distinct from ($2,$3) then now() else updated_at end
    where id=$1`,[i.id,status,reason,seq,delay]);
  if(i.status!==status || i.review_reason!==reason)await c.query("insert into audit_log(actor,action,detail) values('oxapay',$1,$2)",
    ['invoice.'+status,{id:i.id,reason}]);
  if(status==='paying' && !i.pending_at){
    await c.query('update oxapay_invoices set pending_at=now() where id=$1',[i.id]);
    await c.query("select notify_player($1,'deposit.pending',$2,$3,$4)",[i.user_id,'oxapay:'+i.id,i.asset_id,i.amount]);
  }
}
async function bindTrack(c:PoolClient,i:Invoice,track:string):Promise<boolean> {
  if(i.track_id)return i.track_id===track;
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['oxapay:track:'+track]);
  if((await c.query('select 1 from oxapay_invoices where track_id=$1',[track])).rowCount)return false;
  await c.query('update oxapay_invoices set track_id=$2 where id=$1',[i.id,track]);
  return true;
}

/** Production uses the fixed v1 HTTPS origin. Only code constructing a fixture can inject transport. */
export class OxaPay {
  constructor(private readonly send:typeof fetch=(input,init)=>{
    if(config.env==='test')throw new Error('Test payments require a fixture transport');
    return fetch(input,init);
  }) {}

  // Wire contracts: docs.oxapay.com/api-reference/payment/{generate-invoice,payment-information,payment-history}
  private async api(path:string,key?:string,body?:string):Promise<Fields> {
    const res=await this.send('https://api.oxapay.com/v1'+path,{method:body===undefined?'GET':'POST',body,
      headers:{'Content-Type':'application/json',...(key?{merchant_api_key:key}:{})},redirect:'error',signal:AbortSignal.timeout(8000)});
    const reader=res.body?.getReader();
    if(!reader)throw new Error('Missing provider response');
    const chunks:Uint8Array[]=[], limit=1024*1024; let size=0;
    try {
      for(;;){
        const item=await reader.read(); if(item.done)break;
        size+=item.value.length;
        if(size>limit){await reader.cancel();throw new Error('Oversize provider response');}
        chunks.push(item.value);
      }
    } finally {reader.releaseLock();}
    const out=exactJson(Buffer.concat(chunks,size).toString('utf8'));
    if((res.status===400 || res.status===401) && out.status===String(res.status) && text(obj(out.error).type) && !Object.keys(obj(out.data)).length)throw new Rejected();
    if(res.status!==200 || out.status!=='200' || (out.error!=null && (typeof out.error!=='object' || Array.isArray(out.error) || Object.keys(out.error).length)))throw new Error('Provider unavailable');
    if(!out.data || typeof out.data!=='object' || Array.isArray(out.data))throw new Error('Invalid provider response');
    return obj(out.data);
  }

  async create(uid:string,input:InvoiceRequest) {
    const {i,key}=await tx(async c=>{
      await lockActivePlayer(c,uid);
      const prior=(await c.query<Invoice>('select * from oxapay_invoices where user_id=$1 and request=$2',[uid,input.request])).rows[0];
      if(prior){
        if(prior.asset_id!==input.asset || BigInt(prior.amount)!==requestedUnits(input.amount,prior.decimals))throw new InvoiceError(409,'This request belongs to a different invoice');
        return {i:prior,key:null};
      }
      const publicOrigin=origin();
      await issuanceGate(c);
      await c.query('select pg_advisory_xact_lock_shared(hashtext($1))',[merchant]);
      await c.query('select name from secrets where name=$1 for share',[merchant]);
      const key=await getSecret(merchant,c);
      if(!key)throw new InvoiceError(503,'Hosted deposits are not configured');
      const asset=(await c.query(`select id,symbol,decimals,min_deposit from assets where id=$1 and enabled and
        (kind='native' or (kind='ledger' and id='USDT')) for share`,[input.asset])).rows[0];
      if(!asset || asset.id!==asset.symbol || !/^[A-Z0-9]{1,16}$/.test(asset.symbol))throw new InvoiceError(400,'Choose an available playing currency');
      const amount=requestedUnits(input.amount,asset.decimals);
      if(amount<BigInt(asset.min_deposit))throw new InvoiceError(400,'Amount is below the deposit minimum');
      const recent=(await c.query(`select (select count(*)::int from oxapay_invoices where user_id=$1 and created_at>now()-interval '1 hour') as n,
        exists(select 1 from oxapay_invoices where user_id=$1 and asset_id=$2 and (status='creating' or
        (status='review' and track_id is null and dispatched_at is not null and amount=$3))) as busy`,[uid,input.asset,amount.toString()])).rows[0];
      if(recent.busy)throw new InvoiceError(409,'A checkout is still being created. Check your existing invoice.');
      if(recent.n>=20)throw new InvoiceError(429,'Too many new invoices. Try again later.');
      const i=(await c.query<Invoice>(`insert into oxapay_invoices(user_id,request,asset_id,symbol,decimals,amount,public_origin)
        values($1,$2,$3,$4,$5,$6,$7) returning *`,[uid,input.request,asset.id,asset.symbol,asset.decimals,amount.toString(),publicOrigin])).rows[0]!;
      return {i,key};
    });
    if(!key)return publicInvoice(i);

    let dispatched=false;
    try {
      const [accepted,currencies]=await Promise.all([this.api('/payment/accepted-currencies',key),this.api('/common/currencies')]);
      if(!Array.isArray(accepted.list) || !accepted.list.some(s=>text(s).toUpperCase()===i.symbol))throw new InvoiceError(400,'This currency is unavailable at checkout');
      const {networks,aliases}=networkSnapshot(currencies,i.symbol,BigInt(i.amount),i.decimals);
      dispatched=await tx(async c=>{
        await lockActivePlayer(c,uid); await issuanceGate(c);
        return Boolean((await c.query(`update oxapay_invoices set dispatched_at=now(),networks=$2,network_aliases=$3
          where id=$1 and status='creating' and dispatched_at is null`,[i.id,networks,JSON.stringify(aliases)])).rowCount);
      });
      if(dispatched){
        const fields={currency:i.symbol,lifetime:60,fee_paid_by_payer:1,under_paid_coverage:0,mixed_payment:false,auto_withdrawal:false,
          order_id:i.id,callback_url:i.public_origin+'/api/oxapay/webhook',return_url:i.public_origin+'/account/deposit?invoice='+i.id,sandbox:false};
        // A validated, integer-derived decimal literal, not a rounded JS Number or a quoted API string.
        const data=await this.api('/payment/invoice',key,'{"amount":'+formatAmount(BigInt(i.amount),i.decimals)+','+JSON.stringify(fields).slice(1));
        const track=text(data.track_id), url=checkout(data.payment_url), end=expiry(data.expired_at);
        if(!tracking.test(track))throw new Error('Missing tracking reference');
        const check=await tx(async c=>{
          const current=(await c.query<Invoice>('select * from oxapay_invoices where id=$1 for update',[i.id])).rows[0]!;
          if(current.status==='credited' || current.status==='failed')return; // A signed callback may beat the POST response.
          if(!await bindTrack(c,current,track))return recordState(c,current,'review','track_conflict');
          if(!url || !end || end.getTime()<=Date.now() || end.getTime()>Date.now()+2*3600000)return recordState(c,current,'review','invalid_checkout');
          await c.query("update oxapay_invoices set payment_url=$2,expires_at=$3,next_check_at=now()+interval '30 seconds' where id=$1",[i.id,url,end]);
          return true;
        });
        // Refuse to launch a checkout the gateway rounded or denominated
        // differently. A temporarily unavailable lookup is retried by the worker.
        if(check)await this.verify(i.id,track,key);
      }
    } catch(error) {
      await tx(async c=>{
        const current=(await c.query<Invoice>('select * from oxapay_invoices where id=$1 for update',[i.id])).rows[0]!;
        if(current.status!=='creating' || current.track_id)return;
        if(!dispatched || error instanceof Rejected)await recordState(c,current,'failed',dispatched?'provider_rejected':'checkout_unavailable');
        else await recordState(c,current,'creating','creation_uncertain');
      });
      if(!dispatched && error instanceof InvoiceError)throw error;
      if(!dispatched && (error as {statusCode?:number}).statusCode===403)throw error;
    }
    return publicInvoice((await query<Invoice>('select * from oxapay_invoices where id=$1',[i.id])).rows[0]!);
  }

  private async verify(id:string,track:string,key:string) {
    // Sequence successful observations across replicas without holding a DB lock over network I/O.
    const probe=(await query<{probe_seq:string}>(`update oxapay_invoices set probe_seq=probe_seq+1 where id=$1 and dispatched_at is not null
      and journal_id is null and status<>'failed' and (track_id=$2 or track_id is null) returning probe_seq`,[id,track])).rows[0];
    if(!probe)return;
    const info=await this.api('/payment/'+encodeURIComponent(track),key);
    await tx(async c=>{
      const i=(await c.query<Invoice>('select * from oxapay_invoices where id=$1 for update',[id])).rows[0]!;
      if(i.status==='credited' || i.status==='failed' || BigInt(i.applied_seq)>=BigInt(probe.probe_seq) || (i.track_id && i.track_id!==track))return;
      const state=(s:Status,r:string|null=null)=>recordState(c,i,s,r,probe.probe_seq);
      if(info.order_id!==i.id || info.track_id!==track || info.type!=='invoice' || text(info.currency).toUpperCase()!==i.symbol || units(info.amount,i.decimals)!==BigInt(i.amount) ||
        (info.callback_url!=null && info.callback_url!==i.public_origin+'/api/oxapay/webhook') ||
        (info.return_url!=null && info.return_url!==i.public_origin+'/account/deposit?invoice='+i.id) ||
        (info.sandbox!=null && info.sandbox!==false && info.sandbox!=='0') ||
        (info.mixed_payment!=null && info.mixed_payment!==false && info.mixed_payment!=='0') ||
        (info.under_paid_coverage!=null && units(info.under_paid_coverage,18)!==0n) ||
        (info.fee_paid_by_payer!=null && info.fee_paid_by_payer!==true && units(info.fee_paid_by_payer,18)!==10n**18n)){
        return state('review','invoice_mismatch'); // Never attach an unverified candidate track.
      }
      if(!await bindTrack(c,i,track))return state('review','track_conflict');
      const end=expiry(info.expired_at);
      if(end)await c.query('update oxapay_invoices set expires_at=coalesce(expires_at,$2) where id=$1',[i.id,end]);
      const status=text(info.status).toLowerCase();
      if(status==='new' || status==='waiting')return i.payment_url?state('waiting'):state('review','missing_checkout_url');
      if(status==='paying' || status==='underpaid' || status==='expired')return state(status);
      if(status==='refunded')return state('failed','refunded');
      if(status!=='paid')return state('review',status==='manual_accept'?'manually_accepted':'unverified_status');
      const evidence=transfers(info,i);
      if(typeof evidence==='string')return state(evidence==='short_payment'?'underpaid':'review',evidence);
      const evidenceJson=JSON.stringify(evidence);
      const overlap=await c.query(`select 1 from jsonb_to_recordset($1) t(chain_id text,address text) join deposit_addresses d on
        d.chain_id=t.chain_id and d.address=case when t.chain_id in ('ETH','BSC','POL') then lower(t.address) else t.address end limit 1`,[evidenceJson]);
      if(overlap.rowCount)return state('review','direct_address_overlap');
      const claimed=await c.query(`insert into oxapay_transfers(invoice_id,chain_id,txid,amount,address)
        select $1,t.chain_id,t.txid,t.amount,t.address from jsonb_to_recordset($2) t(chain_id text,txid text,amount numeric,address text)
        order by t.chain_id,t.txid on conflict do nothing`,[i.id,evidenceJson]);
      if(claimed.rowCount!==evidence.length){
        await c.query('delete from oxapay_transfers where invoice_id=$1',[i.id]);
        return state('review','transfer_claimed');
      }
      const amount=BigInt(i.amount), ref='oxapay:'+i.id;
      const journal=await post(c,'deposit',ref,[{account:'ext:oxapay',asset:i.asset_id,delta:-amount},{account:'u:'+i.user_id,asset:i.asset_id,delta:amount}]);
      await c.query(`update oxapay_invoices set status='credited',journal_id=$2,credited_at=now(),updated_at=now(),next_check_at=null,
        applied_seq=$3,review_reason=null where id=$1`,[i.id,journal,probe.probe_seq]);
      const single=evidence.length===1?evidence[0]:undefined;
      await c.query("select notify_player($1,'deposit.credited',$2,$3,$4,$5,$6)",[i.user_id,ref,i.asset_id,i.amount,single?.chain_id??null,single?.txid??null]);
      await c.query("insert into audit_log(actor,action,detail) values('oxapay','invoice.credited',$1)",[{id:i.id,track_id:track,journal_id:journal}]);
    });
  }

  async webhook(raw:Buffer,signature:unknown) {
    if(typeof signature!=='string' || !/^[\da-f]{128}$/i.test(signature))throw new InvoiceError(400,'Invalid callback signature');
    const key=await getSecret(merchant);
    if(!key)throw new InvoiceError(503,'Callback verification unavailable');
    const expected=createHmac('sha512',key).update(raw).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new InvoiceError(400,'Invalid callback signature');
    let payload:Fields;
    try {payload=exactJson(raw.toString('utf8'));}catch{throw new InvoiceError(400,'Invalid callback data');}
    const track=text(payload.track_id), id=text(payload.order_id);
    if(payload.type!=='invoice' || !tracking.test(track))throw new InvoiceError(400,'Invalid callback data');
    if(!uuid.test(id))return; // An authenticated event for some other merchant order.
    await this.verify(id,track,key); // Neither IPN status/amount nor a browser return credits a player.
  }

  private async recover(i:Invoice,key:string) {
    if(i.track_id)return this.verify(i.id,i.track_id,key);
    if(!i.dispatched_at){
      await tx(async c=>{
        const stale=(await c.query<Invoice>(`select * from oxapay_invoices where id=$1 and dispatched_at is null and status='creating'
          and created_at<now()-interval '90 seconds' for update`,[i.id])).rows[0];
        if(stale)await recordState(c,stale,'failed','not_dispatched');
      });
      return;
    }
    // v1 history has no order_id query parameter. Page a bounded creation-time
    // window and match the persisted order ID; only Payment Information can settle it.
    const at=Math.floor(i.dispatched_at.getTime()/1000);
    const params=new URLSearchParams({type:'invoice',currency:i.symbol,from_date:String(at-300),to_date:String(Math.min(at+600,Math.floor(Date.now()/1000))),
      sort_by:'create_date',sort_type:'asc',size:'50',page:String(i.history_page)});
    const page=await this.api('/payment?'+params,key);
    if(!Array.isArray(page.list))throw new Error('Invalid payment history');
    const tracks=page.list.map(obj).filter(o=>o.order_id===i.id && o.type==='invoice').map(o=>text(o.track_id));
    if(tracks.length===1 && tracking.test(tracks[0]!))return this.verify(i.id,tracks[0]!,key);
    const last=Number(obj(page.meta).last_page);
    if(!Number.isSafeInteger(last) || last<0)throw new Error('Invalid payment history pagination');
    await tx(async c=>{
      const current=(await c.query<Invoice>('select * from oxapay_invoices where id=$1 and track_id is null for update',[i.id])).rows[0];
      if(!current || !['creating','review'].includes(current.status))return;
      await c.query('update oxapay_invoices set history_page=$2 where id=$1',[i.id,i.history_page<last?i.history_page+1:1]);
      const review=tracks.length>0 || Date.now()-at*1000>2*3600000;
      await recordState(c,current,review?'review':'creating',tracks.length?'ambiguous_history':'creation_uncertain');
    });
  }

  async reconcile():Promise<void> {
    // Claim a finite batch; another replica can reclaim it if this one dies. No
    // database transaction spans the provider request and no player needs to poll.
    const due=(await query<Invoice>(`with batch as (select id from oxapay_invoices where next_check_at<=now()
      order by next_check_at,id for update skip locked limit 8) update oxapay_invoices i set next_check_at=now()+interval '2 minutes'
      from batch where i.id=batch.id returning i.*`)).rows;
    if(!due.length)return;
    const key=await getSecret(merchant);
    if(!key)throw new Error('Merchant unavailable');
    const results=await Promise.allSettled(due.map(i=>this.recover(i,key)));
    if(results.some(r=>r.status==='rejected'))throw new Error('Invoice lookup unavailable');
  }
}

export async function ownedInvoices(uid:string,id?:string) {
  const rows=(await query<Invoice>(`select * from oxapay_invoices where user_id=$1 and ($2::uuid is null or id=$2)
    order by created_at desc,id desc limit 50`,[uid,id??null])).rows;
  return rows.map(publicInvoice);
}
