import type { PoolClient } from 'pg';
import { id } from 'ethers';
import { base58 } from '@scure/base';
import { query, tx } from '../db.js';
import { createAlchemyFetch, flushRpcFailure, getRpcConfig, type RpcEndpoint } from './rpc.js';
import { creditConfirmedDeposit } from '../ledger.js';
import { associatedTokenAccount, TOKEN_PROGRAM, tronAddress } from './receive.js';
import { createSolRpc, SOL_MAX_VERSION } from './sol-rpc.js';
import { scanIntervalMs } from './scan-policy.js';

type Payment={address:string;asset:string;amount:bigint;txid:string;index:number};
type Block={height:number;hash:string;parent:string;payments:Payment[]};
type Routes={owners:Map<string,string>;native?:string;tokens:Map<string,string>};
const BTC_GENESIS='000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const SOL_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM='11111111111111111111111111111111';
const TRANSFER=id('Transfer(address,address,uint256)').slice(2);
function integer(v:unknown):bigint{
  if(typeof v==='number' && !Number.isSafeInteger(v))throw new Error('Inexact amount');
  if(!/^\d+$/.test(String(v)))throw new Error('Invalid amount');
  return BigInt(String(v));
}
export function bitcoinPayments(block:any,r:Routes):Payment[]{
  const result:Payment[]=[];
  if(!r.native)return result;
  for(const tx of block.tx){
    if(tx.vin?.some((input:any)=>input.coinbase))continue; // mined coins have a separate maturity rule
    for(const out of tx.vout){
      const address=out.scriptPubKey?.address;
      if(!r.owners.has(address))continue;
      // Bitcoin Core may serialize a single satoshi using scientific notation.
      const m=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,2}))?$/i.exec(String(out.value));
      if(!m)throw new Error('Invalid BTC output');
      const digits=BigInt(m[1]!+(m[2]||'')),shift=8+Number(m[3]||0)-(m[2]?.length||0);
      if(shift<0 && digits%10n**BigInt(-shift)!==0n)throw new Error('Inexact BTC output');
      const amount=shift>=0?digits*10n**BigInt(shift):digits/10n**BigInt(-shift);
      result.push({address,asset:r.native,amount,txid:tx.txid,index:out.n});
    }
  }
  return result;
}
export function solanaPayments(block:any,r:Routes):Payment[]{
  const result:Payment[]=[];
  for(const entry of block.transactions){
    const meta=entry.meta;
    if(!meta || !Object.hasOwn(meta,'err') || (meta.err!==null && (typeof meta.err!=='object'||Array.isArray(meta.err))) ||
      !Array.isArray(entry.transaction?.message?.instructions) || !Array.isArray(entry.transaction.message.accountKeys))throw new Error('Missing transaction metadata');
    if(meta.err)continue;
    if(!Array.isArray(meta.innerInstructions))throw new Error('Missing transaction metadata');
    const message=entry.transaction.message,txid=entry.transaction.signatures[0];
    const destinations=new Map<string,{owner:string;asset:string;mint:string}>();
    if(r.tokens.size&&!Array.isArray(meta.postTokenBalances))throw new Error('Missing token metadata');
    for(const balance of meta.postTokenBalances||[]){
      const asset=r.tokens.get(balance.mint);
      if(!asset || !r.owners.has(balance.owner))continue;
      const address=message.accountKeys[balance.accountIndex]?.pubkey;
      if(address===associatedTokenAccount(balance.owner,balance.mint))
        destinations.set(address,{owner:balance.owner,asset,mint:balance.mint});
    }
    const inner=new Map<number,any[]>();
    for(const nested of meta.innerInstructions){
      if(!Number.isSafeInteger(nested.index)||nested.index<0||nested.index>=message.instructions.length||inner.has(nested.index)||!Array.isArray(nested.instructions))
        throw new Error('Invalid inner instructions');
      inner.set(nested.index,nested.instructions);
    }
    let index=0;
    for(const [i,ix] of message.instructions.entries())for(const op of [ix,...(inner.get(i)||[])]){
      if(!op||typeof op.programId!=='string'||(op.programId===SYSTEM&&!op.parsed))throw new Error('Incomplete parsed instruction');
      const n=index++, type=op.parsed?.type, info=op.parsed?.info;
      if(op.parsed&&(typeof type!=='string'||!info||typeof info!=='object'||Array.isArray(info)))throw new Error('Incomplete parsed instruction');
      if(!['transfer','transferChecked','transferWithSeed'].includes(type))continue;
      if(op.programId===SYSTEM){
        if(typeof info.source!=='string'||typeof info.destination!=='string'||info.lamports===undefined)throw new Error('Incomplete native transfer');
        const amount=integer(info.lamports);
        if(info.source!==info.destination&&r.native && r.owners.has(info.destination))result.push({txid,index:n,address:info.destination,asset:r.native,amount});
      }
      if(!info||info.source===info.destination)continue;
      const target=destinations.get(info.destination);
      if(op.programId===TOKEN_PROGRAM && target && (!info.mint || info.mint===target.mint))
        result.push({txid,index:n,address:target.owner,asset:target.asset,amount:integer(info.tokenAmount?.amount??info.amount)});
    }
  }
  return result;
}
export async function tronPayments(block:any,r:Routes,blockReceipts:()=>Promise<any[]>):Promise<Payment[]>{
  const result:Payment[]=[];
  let receipts:Map<string,any>|undefined;
  for(const t of block.transactions||[]){
    const contracts=t.raw_data?.contract;
    if(!contracts || !t.ret || contracts.length!==t.ret.length)throw new Error('Missing TRON transaction status');
    for(const [i,op] of contracts.entries()){
      if(t.ret[i].contractRet!=='SUCCESS')continue;
      if(op.type==='TransferContract' && r.native){
        const p=op.parameter.value,dest=tronAddress(p.to_address);
        if(r.owners.has(dest))result.push({address:dest,asset:r.native,amount:integer(p.amount),txid:t.txID,index:-1-i});
      }
    }
    if(!r.tokens.size || !contracts.some((op:any)=>['TriggerSmartContract','CreateSmartContract'].includes(op.type)))continue;
    if(!receipts)receipts=new Map((await blockReceipts()).map(row=>[row.id,row]));
    const info=receipts.get(t.txID);
    if(!info || info.id!==t.txID || info.blockNumber!==block.block_header.raw_data.number)throw new Error('Missing TRON receipt');
    if(info.result==='FAILED' || info.receipt?.result!=='SUCCESS')continue;
    for(const [i,log] of (info.log||[]).entries()){
      if(log.topics?.length!==3 || log.topics[0]!==TRANSFER || !/^[0-9a-f]{64}$/i.test(log.data))continue;
      const asset=r.tokens.get(tronAddress(log.address)),address=tronAddress(log.topics[2].slice(-40));
      if(asset && r.owners.has(address))result.push({address,asset,txid:t.txID,index:i,amount:BigInt('0x'+log.data)});
    }
  }
  return result;
}

class NodeRpc{
  constructor(readonly endpoint:string,readonly transport:typeof fetch=fetch){}
  async post(path:string,body:unknown){
    const url=new URL(this.endpoint);
    if(path)url.pathname=url.pathname.replace(/\/$/,'')+path;
    const headers:Record<string,string>={'content-type':'application/json'};
    if(url.username||url.password){
      headers.authorization='Basic '+Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64');
      url.username=url.password='';
    }
    const res=await this.transport(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw new Error('Node unavailable');
    // Node 22 JSON.parse supplies the original token. Preserve Bitcoin decimal
    // amounts and full-width Solana lamport amounts before JS can round them.
    const parsed=JSON.parse(await res.text(),((key:string,value:any,context?:{source?:string})=>
      typeof value==='number' && (key==='value' || !Number.isSafeInteger(value)) ? context?.source??value : value) as any);
    return parsed;
  }
  async call(method:string,params:any[]=[],path=''){
    const d=await this.post(path,{jsonrpc:'2.0',method,params,id:1});
    if(d.error || d.result==null)throw new Error('Missing RPC result');
    return d.result;
  }
}
class Network{
  constructor(readonly id:string,readonly rpc:NodeRpc){}
  async head():Promise<number>{
    if(this.id==='BTC'){
      const info=await this.rpc.call('getblockchaininfo');
      if(info.chain!=='main' || info.initialblockdownload || (await this.rpc.call('getblockhash',[0]))!==BTC_GENESIS)throw new Error('Bitcoin node unavailable');
      return info.blocks;
    }
    if(this.id==='SOL'){
      if(await this.rpc.call('getGenesisHash')!==SOL_GENESIS)throw new Error('Solana network mismatch');
      return this.rpc.call('getSlot',[{commitment:'finalized'}]);
    }
    if(BigInt(await this.rpc.call('eth_chainId',[],'/jsonrpc'))!==0x2b6653dcn)throw new Error('TRON network mismatch');
    return (await this.rpc.post('/walletsolidity/getnowblock',{})).block_header.raw_data.number;
  }
  async heights(from:number,to:number):Promise<number[]>{
    if(from>to)return [];
    if(this.id==='SOL')return this.rpc.call('getBlocks',[from,to,{commitment:'finalized'}]);
    return Array.from({length:to-from+1},(_,i)=>from+i);
  }
  async hash(n:number):Promise<string>{
    if(this.id==='BTC')return this.rpc.call('getblockhash',[n]);
    if(this.id==='SOL')return (await this.rpc.call('getBlock',[n,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:SOL_MAX_VERSION}])).blockhash;
    return (await this.rpc.post('/walletsolidity/getblockbynum',{num:n})).blockID;
  }
  async block(n:number,r:Routes):Promise<Block>{
    if(this.id==='BTC'){
      const hash=await this.hash(n), b=await this.rpc.call('getblock',[hash,2]);
      if(b.height!==n||b.hash!==hash)throw new Error('Unexpected Bitcoin block');
      return {height:n,hash,parent:b.previousblockhash,payments:bitcoinPayments(b,r)};
    }
    if(this.id==='SOL'){
      const b=await this.rpc.call('getBlock',[n,{commitment:'finalized',encoding:'jsonParsed',transactionDetails:'full',maxSupportedTransactionVersion:SOL_MAX_VERSION,rewards:false}]);
      return {height:n,hash:b.blockhash,parent:b.previousBlockhash,payments:solanaPayments(b,r)};
    }
    const b=await this.rpc.post('/walletsolidity/getblockbynum',{num:n});
    if(b.block_header?.raw_data.number!==n)throw new Error('Missing TRON block');
    return {height:n,hash:b.blockID,parent:b.block_header.raw_data.parentHash,
      payments:await tronPayments(b,r,()=>this.rpc.post('/walletsolidity/gettransactioninfobyblocknum',{num:n}))};
  }
}
export class NonEvmWatcher{
  private endpoint?:RpcEndpoint;
  needsCatchUp=false;
  constructor(readonly chainId:string,private readonly scheduled=false){}
  async tick(){
    this.needsCatchUp=false;
    try{return await this.scan();}
    finally{if(this.endpoint)await flushRpcFailure(this.endpoint).catch(()=>{});}
  }
  private async scan(){
    if(this.chainId==='SOL'){
      try{return await this.solTick();}
      catch(error){await query("update chains set scan_ready_at=null where id='SOL'").catch(()=>{});throw error;}
    }
    await tx(async c=>{
      const cid=this.chainId;
      const chain=(await c.query(`select * from chains where id=$1 and enabled
        and (not $2::boolean or next_scan_at is null or next_scan_at<=clock_timestamp()) for update skip locked`,[cid,this.scheduled])).rows[0];
      if(!chain)return;
      const endpoint=await getRpcConfig(cid,c);if(!endpoint)throw new Error('Missing endpoint');
      this.endpoint=endpoint;
      const transport=endpoint.provider==='legacy'?fetch:createAlchemyFetch(endpoint);
      const network=new Network(cid,new NodeRpc(endpoint.url,transport)),head=await network.head();
      if(!Number.isSafeInteger(head)||head<=0)throw new Error('Invalid chain head');
      let cursor=Number(chain.last_scanned);
      if(head<cursor)return;
      const checkpoints=(await c.query<{height:string;hash:string}>('select height,hash from scanned_blocks where chain_id=$1 order by height desc',[cid])).rows;
      let parent=checkpoints[0]?.hash;
      if(parent && await network.hash(Number(checkpoints[0]!.height))!==parent){
        let shared:typeof checkpoints[number]|undefined;
        for(const old of checkpoints.slice(1)){if(await network.hash(Number(old.height))===old.hash){shared=old;break;}}
        if(!shared)throw new Error('Historical reconciliation required');
        cursor=Number(shared.height);parent=shared.hash;
        if((await c.query('select 1 from deposits where chain_id=$1 and block_number>$2 and journal_id is not null limit 1',[cid,cursor])).rowCount)throw new Error('Credited reorganization requires reconciliation');
        await c.query("update deposits set status='orphaned', confirmations=0 where chain_id=$1 and block_number>$2 and journal_id is null",[cid,cursor]);
        await c.query('delete from scanned_blocks where chain_id=$1 and height>$2',[cid,cursor]);
      }
      const assets=(await c.query("select * from assets where chain_id=$1 and enabled and (symbol<>'USDT' or chain_id='SOL')",[cid])).rows;
      const minimum=new Map(assets.map(a=>[String(a.id),BigInt(a.min_deposit)]));
      const assigned=(await c.query<{address:string;user_id:string;custody_kind:string}>('select address,user_id,custody_kind from deposit_addresses where chain_id=$1',[cid])).rows;
      if(!cursor&&assigned.length)throw new Error('Existing deposit addresses require history reconciliation');
      if(!cursor)cursor=head-1;
      const end=Math.min(head,cursor+40);
      const owners=new Map(assigned.map(a=>[a.address,a.user_id])),managed=new Set(assigned.filter(a=>a.custody_kind==='managed').map(a=>a.address));
      const routes:Routes={owners,native:assets.find(a=>a.kind==='native')?.id,tokens:new Map(assets.filter(a=>a.token_address).map(a=>[a.token_address,a.id]))};
      for(const height of await network.heights(cursor+1,end)){
        let block:Block;
        if(owners.size)block=await network.block(height,routes);
        else block={height,hash:await network.hash(height),parent:parent||'',payments:[]};
        if(!block.hash || (parent && block.parent!==parent))throw new Error('Inconsistent block history');
        parent=block.hash;
        for(const p of block.payments){
          if(cid==='SOL' && managed.has(p.address) && p.asset!=='SOL')continue;
          if(p.amount<=0n || p.amount<minimum.get(p.asset)!)continue;
          await c.query(`insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,required_conf)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(chain_id,txid,log_index) do update set
            status='pending',block_number=excluded.block_number,block_hash=excluded.block_hash,amount=excluded.amount,
            asset_id=excluded.asset_id,user_id=excluded.user_id,address=excluded.address,required_conf=excluded.required_conf,confirmed_at=null
            where deposits.status='orphaned' and deposits.journal_id is null`,
            [cid,p.asset,owners.get(p.address),p.address,p.txid,p.index,p.amount.toString(),height,block.hash,chain.required_conf]);
        }
        await c.query('insert into scanned_blocks values($1,$2,$3)',[cid,height,block.hash]);
      }
      await this.confirm(c,network,head,end);
      await c.query(`update chains set last_scanned=$2,scan_ready_at=case when $2=$3::bigint and
        ($4::bigint is null or $4=(select routing_epoch from alchemy_rpc_state where singleton)) then now() end,
        next_scan_at=clock_timestamp()+($5::integer*interval '1 millisecond') where id=$1`,
      [cid,end,head,endpoint.epoch,end<head?1000:scanIntervalMs(cid)]);
      await c.query('delete from scanned_blocks where chain_id=$1 and height<$2',[cid,end-Math.max(256,chain.required_conf+40)]);
      this.needsCatchUp=end<head;
    });
  }
  private async solTick(){
    await tx(async c=>{
      const chain=(await c.query(`select * from chains where id='SOL' and enabled
        and (not $1::boolean or next_scan_at is null or next_scan_at<=clock_timestamp()) for update skip locked`,[this.scheduled])).rows[0];
      if(!chain)return;
      const endpoint=await getRpcConfig('SOL',c);if(!endpoint)throw new Error('Solana RPC unavailable');
      this.endpoint=endpoint;
      const rpc=createSolRpc(endpoint.url,{fetch:endpoint.provider==='legacy'?undefined:createAlchemyFetch(endpoint),throttle:process.env.NODE_ENV!=='test'}),finalized={commitment:'finalized'};
      const number=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('Invalid Solana evidence');return Number(value);};
      const bytes=(value:unknown,length:number)=>{try{if(typeof value!=='string'||base58.decode(value).length!==length)throw 0;return value;}catch{throw new Error('Invalid Solana evidence');}};
      if(await rpc('getGenesisHash')!==SOL_GENESIS)throw new Error('Solana network mismatch');
      const head=number(await rpc('getSlot',[finalized]));
      const first=Math.max(number(await rpc('getFirstAvailableBlock')),number(await rpc('minimumLedgerSlot')));
      if(!head||first>head)throw new Error('Solana history unavailable');
      const blocks=new Map<number,any>();
      const block=async(height:number)=>{
        if(!blocks.has(height)){
          const value=await rpc('getBlock',[height,{...finalized,transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:SOL_MAX_VERSION}]);
          if(!value||!Array.isArray(value.signatures))throw new Error('Solana block unavailable');
          bytes(value.blockhash,32);for(const signature of value.signatures)bytes(signature,64);
          blocks.set(height,value);
        }
        return blocks.get(height)!;
      };
      const tip=await block(head),time=number(tip.blockTime),age=Math.floor(Date.now()/1000)-time;
      if(age < -30 || age>120)throw new Error('Solana head is stale');
      let cursor=number(Number(chain.last_scanned));
      if(head<cursor)throw new Error('Solana head regressed');
      const checkpoints=(await c.query<{height:string;hash:string}>("select height,hash from scanned_blocks where chain_id='SOL' order by height desc limit 33")).rows;
      const anchor=checkpoints[0];
      if(anchor && (Number(anchor.height)<first || Number(anchor.height)>head))throw new Error('Solana retained history unavailable');
      if(anchor && (await block(Number(anchor.height))).blockhash!==anchor.hash){
        let shared:typeof anchor|undefined;
        for(const old of checkpoints.slice(1,33)){
          if(Number(old.height)<first)break;
          if((await block(Number(old.height))).blockhash===old.hash){shared=old;break;}
        }
        if(!shared)throw new Error('Solana historical reconciliation required');
        const common=Number(shared.height);
        if((await c.query("select 1 from deposits where chain_id='SOL' and block_number>$1 and journal_id is not null limit 1",[common])).rowCount)
          throw new Error('Credited Solana reorganization requires reconciliation');
        await c.query("update deposits set status='orphaned',confirmations=0 where chain_id='SOL' and block_number>$1 and journal_id is null",[common]);
        await c.query("delete from scanned_blocks where chain_id='SOL' and height>$1",[common]);
        await c.query('update sol_address_scans set last_scanned=least(last_scanned,$1),target_slot=null,before_signature=null,before_slot=null,overlap_signature=null,overlap_slot=null,anchor_signature=null,anchor_slot=null,newest_signature=null,newest_slot=null',[common]);
        await c.query("update chains set last_scanned=least(last_scanned,$1),scan_ready_at=null where id='SOL'",[common]);
        return;
      }
      const assigned=(await c.query<{id:string;address:string;user_id:string;custody_kind:string}>("select id,address,user_id,custody_kind from deposit_addresses where chain_id='SOL'")).rows;
      // A populated old wallet with no recorded coverage cannot safely start at today's head.
      if(assigned.length && (!cursor || first>cursor))throw new Error('Solana receive history requires reconciliation');
      const assets=(await c.query("select * from assets where chain_id='SOL' and enabled")).rows;
      const minimum=new Map(assets.map(a=>[String(a.id),BigInt(a.min_deposit)]));
      const owners=new Map(assigned.map(a=>[a.address,a.user_id])),managed=new Set(assigned.filter(a=>a.custody_kind==='managed').map(a=>a.address));
      const routes:Routes={owners,native:assets.find(a=>a.kind==='native')?.id,tokens:new Map(assets.filter(a=>a.token_address).map(a=>[a.token_address,a.id]))};
      const target=anchor && Number(anchor.height)>cursor?Number(anchor.height):head;
      const targetBlock=await block(target);
      await c.query("insert into scanned_blocks(chain_id,height,hash) values('SOL',$1,$2) on conflict do nothing",[target,targetBlock.blockhash]);
      const proof=async(signature:string,at:number,queryAddress?:string)=>{
        const value=await rpc('getTransaction',[signature,{...finalized,encoding:'jsonParsed',maxSupportedTransactionVersion:SOL_MAX_VERSION}]);
        if(!value||number(value.slot)!==at||value.transaction?.signatures?.[0]!==signature||
          ![undefined,'legacy',0,1].includes(value.version)||!value.meta)throw new Error('Solana transaction unavailable');
        if(queryAddress&&!value.transaction.message?.accountKeys?.some((key:any)=>key.pubkey===queryAddress))throw new Error('Unrelated Solana history entry');
        // Also validates that the parser has the complete inner-instruction metadata.
        const payments=solanaPayments({transactions:[value]},routes),canonical=await block(at);
        if(canonical.signatures.filter((s:string)=>s===signature).length!==1)throw new Error('Noncanonical Solana transaction');
        return {payments,hash:canonical.blockhash,meta:value.meta,payer:value.transaction.message.accountKeys[0]?.pubkey};
      };
      // Bootstrap and an invalidated RPC lease must prove parsing even when owned history is empty.
      if(!assigned.length||!chain.scan_ready_at){
        // Native program addresses are commonly excluded from RPC history
        // indexes. Use a real fee payer from this canonical block instead.
        let probe:Awaited<ReturnType<typeof proof>>|undefined;
        for(const signature of tip.signatures.slice(0,4)){
          const candidate=await proof(signature,head);
          if(candidate.meta.err===null){probe=candidate;break;}
        }
        if(!probe)throw new Error('Solana history capability unavailable');
        bytes(probe.payer,32);
        const sample=await rpc('getSignaturesForAddress',[probe.payer,{...finalized,minContextSlot:head,limit:4}]);
        if(!Array.isArray(sample)||sample.length<1||sample.length>4)throw new Error('Solana indexed history unavailable');
        for(const row of sample){
          bytes(row.signature,64);number(row.slot);
          if(row.confirmationStatus!=='finalized'||!Object.hasOwn(row,'err')||
            (row.err!==null&&(typeof row.err!=='object'||Array.isArray(row.err))))throw new Error('Invalid Solana history probe');
        }
        const selected=sample.find(row=>row.err===null);if(!selected)throw new Error('Solana history capability unavailable');
        const signature=selected.signature,at=number(selected.slot);
        if(at<first)throw new Error('Invalid Solana history probe');
        const verified=await proof(signature,at);
        if(verified.meta.err!==null)throw new Error('Invalid Solana history probe');
        const status=await rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);
        if(!status?.context||number(status.context.slot)<Math.max(head,at)||status.value?.length!==1||
          status.value[0]?.confirmationStatus!=='finalized'||number(status.value[0].slot)!==at||!Object.hasOwn(status.value[0],'err')||
          (status.value[0].err===null)!==(verified.meta.err===null))throw new Error('Solana status history unavailable');
        if(!assigned.length){
          await c.query(`update chains set last_scanned=$1,scan_ready_at=case when $2::bigint=(select routing_epoch from alchemy_rpc_state where singleton)
            then clock_timestamp() end,next_scan_at=clock_timestamp()+($3::integer*interval '1 millisecond') where id='SOL'`,[head,endpoint.epoch,scanIntervalMs('SOL')]);
          return;
        }
      }
      const queries:string[]=[];
      for(const owner of assigned){
        const addresses=[owner.address,...(owner.custody_kind==='legacy'?[...routes.tokens.keys()].map(mint=>associatedTokenAccount(owner.address,mint)):[])];
        for(const address of addresses){
          queries.push(address);
          await c.query('insert into sol_address_scans(query_address,address_id,last_scanned) values($1,$2,$3) on conflict do nothing',[address,owner.id,cursor]);
        }
      }
      // Empty wallets share this canonical snapshot. Stop after the first
      // nonempty page so transaction proofs still commit one bounded page at a
      // time; a later provider failure cannot discard earlier completed pages.
      for(let checked=0;checked<4;checked++){
        const scan=(await c.query(`select * from sol_address_scans where query_address=any($1::text[]) and last_scanned<$2
          order by updated_at,query_address limit 1 for update`,[queries,target])).rows[0];
        if(!scan)break;
        const baseline=number(Number(scan.last_scanned));
        if(first>baseline || (scan.target_slot!==null&&Number(scan.target_slot)!==target))throw new Error('Solana scan history unavailable');
        const before=scan.before_signature as string|null,limit=10;
        const page=await rpc('getSignaturesForAddress',[scan.query_address,{...finalized,minContextSlot:head,limit,...(before?{before}:{} )}]);
        if(!Array.isArray(page)||page.length>limit)throw new Error('Incomplete Solana signature page');
        if(before&&(!page.length||page[0].signature!==scan.overlap_signature||number(page[0].slot)!==Number(scan.overlap_slot)))
          throw new Error('Discontinuous Solana signature page');
        const seen=new Set<string>();let previous=scan.before_slot===null?Number.MAX_SAFE_INTEGER:Number(scan.before_slot),done=false;
        const anchorRequired=scan.anchor_signature&&Number(scan.anchor_slot)>=first;
        let newest:string|null=scan.newest_signature,newestSlot:number|null=scan.newest_slot===null?null:Number(scan.newest_slot);
        for(const row of page){
          const signature=bytes(row.signature,64),at=number(row.slot);
          if(at>previous||signature===before||seen.has(signature)||row.confirmationStatus!=='finalized'||!Object.hasOwn(row,'err')||
            (row.err!==null&&(typeof row.err!=='object'||Array.isArray(row.err))))throw new Error('Invalid Solana signature page');
          previous=at;seen.add(signature);
          if(at>target)continue;
          if(newest===null){newest=signature;newestSlot=at;}
          if(at<=baseline){
            if(!anchorRequired||signature===scan.anchor_signature){done=true;break;}
            continue;
          }
          const verified=await proof(signature,at,scan.query_address);
          if((row.err===null)!==(verified.meta.err===null))throw new Error('Inconsistent Solana transaction status');
          for(const p of verified.payments){
            if(managed.has(p.address)&&p.asset!=='SOL')continue;
            const min=minimum.get(p.asset);if(min===undefined||p.amount<=0n||p.amount<min)continue;
            await c.query(`insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,required_conf)
              values('SOL',$1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(chain_id,txid,log_index) do update set
              status='pending',block_number=excluded.block_number,block_hash=excluded.block_hash,amount=excluded.amount,
              asset_id=excluded.asset_id,user_id=excluded.user_id,address=excluded.address,required_conf=excluded.required_conf,confirmed_at=null
              where deposits.status='orphaned' and deposits.journal_id is null`,
              [p.asset,owners.get(p.address),p.address,p.txid,p.index,p.amount.toString(),at,verified.hash,chain.required_conf]);
          }
          await c.query("insert into scanned_blocks(chain_id,height,hash) values('SOL',$1,$2) on conflict do nothing",[at,verified.hash]);
        }
        if(!done&&page.length<limit){
          if(anchorRequired)throw new Error('Solana signature anchor missing');
          done=true;
        }
        if(done)await c.query(`update sol_address_scans set last_scanned=$2,target_slot=null,before_signature=null,before_slot=null,overlap_signature=null,overlap_slot=null,
          anchor_signature=$3,anchor_slot=$4,newest_signature=null,newest_slot=null,updated_at=clock_timestamp() where query_address=$1`,
          [scan.query_address,target,newest??(anchorRequired?scan.anchor_signature:null),newestSlot??(anchorRequired?Number(scan.anchor_slot):null)]);
        else await c.query(`update sol_address_scans set target_slot=$2,before_signature=$3,before_slot=$4,newest_signature=$5,newest_slot=$6,
          overlap_signature=$7,overlap_slot=$8,updated_at=clock_timestamp() where query_address=$1`,
          [scan.query_address,target,page[page.length-2].signature,page[page.length-2].slot,newest,newestSlot,page[page.length-1].signature,page[page.length-1].slot]);
        if(page.length)break;
      }
      const pending=(await c.query("select * from deposits where chain_id='SOL' and status in ('pending','confirmed') and not review_hold and journal_id is null and block_number<=$1 order by block_number,id limit 20",[target])).rows;
      for(const deposit of pending){
        if((await block(Number(deposit.block_number))).blockhash!==deposit.block_hash)throw new Error('Noncanonical Solana deposit');
        const confirmations=head-Number(deposit.block_number)+1;
        await c.query(`update deposits set confirmations=$2,status=case when $2>=required_conf then 'confirmed' else 'pending' end,
          confirmed_at=case when $2>=required_conf then now() end where id=$1`,[deposit.id,confirmations]);
        if(confirmations>=deposit.required_conf)await creditConfirmedDeposit(c,deposit.id);
      }
      const remaining=(await c.query('select 1 from sol_address_scans where query_address=any($1::text[]) and last_scanned<$2 limit 1',[queries,target])).rowCount;
      if(!remaining){
        const targetAge=Math.floor(Date.now()/1000)-number(targetBlock.blockTime);
        await c.query(`update chains set last_scanned=$1,scan_ready_at=case when $2 and $3::bigint=(select routing_epoch from alchemy_rpc_state where singleton)
          then clock_timestamp() else null end where id='SOL'`,[target,targetAge>=-30&&targetAge<=120,endpoint.epoch]);
        await c.query("delete from scanned_blocks where chain_id='SOL' and height<$1",[target-Math.max(512,chain.required_conf+40)]);
      }
      this.needsCatchUp=!!remaining||target<head;
      await c.query("update chains set next_scan_at=clock_timestamp()+($1::integer*interval '1 millisecond') where id='SOL'",
        [this.needsCatchUp?1000:scanIntervalMs('SOL')]);
    });
  }
  private async confirm(c:PoolClient,network:Network,head:number,end:number){
    const pending=await c.query("select * from deposits where chain_id=$1 and status in ('pending','confirmed') and journal_id is null and block_number<=$2",[this.chainId,end]);
    for(const d of pending.rows){
      const count=head-Number(d.block_number)+1;
      if(count<d.required_conf){await c.query('update deposits set confirmations=$2 where id=$1',[d.id,count]);continue;}
      if(await network.hash(Number(d.block_number))!==d.block_hash)throw new Error('Noncanonical deposit');
      await c.query("update deposits set confirmations=$2,status='confirmed',confirmed_at=now() where id=$1",[d.id,count]);
      await creditConfirmedDeposit(c,d.id);
    }
  }
}
