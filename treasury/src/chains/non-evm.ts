import type { PoolClient } from 'pg';
import { id } from 'ethers';
import { tx } from '../db.js';
import { getSecret } from '../vault.js';
import { creditConfirmedDeposit } from '../ledger.js';
import { associatedTokenAccount, TOKEN_PROGRAM, tronAddress } from './receive.js';

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
    if(!meta)throw new Error('Missing transaction metadata');
    if(meta.err)continue;
    const message=entry.transaction.message,txid=entry.transaction.signatures[0];
    const destinations=new Map<string,{owner:string;asset:string;mint:string}>();
    for(const balance of meta.postTokenBalances||[]){
      const asset=r.tokens.get(balance.mint);
      if(!asset || !r.owners.has(balance.owner))continue;
      const address=message.accountKeys[balance.accountIndex]?.pubkey;
      if(address===associatedTokenAccount(balance.owner,balance.mint))
        destinations.set(address,{owner:balance.owner,asset,mint:balance.mint});
    }
    const inner=new Map<number,any[]>((meta.innerInstructions||[]).map((i:any)=>[i.index,i.instructions]));
    let index=0;
    for(const [i,ix] of message.instructions.entries())for(const op of [ix,...(inner.get(i)||[])]){
      const n=index++, type=op.parsed?.type, info=op.parsed?.info;
      if(!info || !['transfer','transferChecked','transferWithSeed'].includes(type) || info.source===info.destination)continue;
      if(op.programId===SYSTEM && r.native && r.owners.has(info.destination) && info.lamports!==undefined)
        result.push({txid,index:n,address:info.destination,asset:r.native,amount:integer(info.lamports)});
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
  constructor(readonly endpoint:string){}
  async post(path:string,body:unknown){
    const url=new URL(this.endpoint);
    if(path)url.pathname=url.pathname.replace(/\/$/,'')+path;
    const headers:Record<string,string>={'content-type':'application/json'};
    if(url.username||url.password){
      headers.authorization='Basic '+Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64');
      url.username=url.password='';
    }
    const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
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
    if(this.id==='SOL')return (await this.rpc.call('getBlock',[n,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}])).blockhash;
    return (await this.rpc.post('/walletsolidity/getblockbynum',{num:n})).blockID;
  }
  async block(n:number,r:Routes):Promise<Block>{
    if(this.id==='BTC'){
      const hash=await this.hash(n), b=await this.rpc.call('getblock',[hash,2]);
      if(b.height!==n||b.hash!==hash)throw new Error('Unexpected Bitcoin block');
      return {height:n,hash,parent:b.previousblockhash,payments:bitcoinPayments(b,r)};
    }
    if(this.id==='SOL'){
      const b=await this.rpc.call('getBlock',[n,{commitment:'finalized',encoding:'jsonParsed',transactionDetails:'full',maxSupportedTransactionVersion:0,rewards:false}]);
      return {height:n,hash:b.blockhash,parent:b.previousBlockhash,payments:solanaPayments(b,r)};
    }
    const b=await this.rpc.post('/walletsolidity/getblockbynum',{num:n});
    if(b.block_header?.raw_data.number!==n)throw new Error('Missing TRON block');
    return {height:n,hash:b.blockID,parent:b.block_header.raw_data.parentHash,
      payments:await tronPayments(b,r,()=>this.rpc.post('/walletsolidity/gettransactioninfobyblocknum',{num:n}))};
  }
}
export class NonEvmWatcher{
  constructor(readonly chainId:string){}
  async tick(){
    await tx(async c=>{
      const cid=this.chainId;
      const chain=(await c.query('select * from chains where id=$1 and enabled for update skip locked',[cid])).rows[0];
      if(!chain)return;
      const url=await getSecret('rpc:'+cid,c);if(!url)throw new Error('Missing endpoint');
      const network=new Network(cid,new NodeRpc(url)),head=await network.head();
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
      if(!cursor)cursor=head-1;
      const end=Math.min(head,cursor+40);
      const assets=(await c.query("select * from assets where chain_id=$1 and enabled and (symbol<>'USDT' or chain_id='SOL')",[cid])).rows;
      const minimum=new Map(assets.map(a=>[String(a.id),BigInt(a.min_deposit)]));
      const owners=new Map((await c.query<{address:string;user_id:string}>('select address,user_id from deposit_addresses where chain_id=$1',[cid])).rows.map(a=>[a.address,a.user_id]));
      const routes:Routes={owners,native:assets.find(a=>a.kind==='native')?.id,tokens:new Map(assets.filter(a=>a.token_address).map(a=>[a.token_address,a.id]))};
      for(const height of await network.heights(cursor+1,end)){
        let block:Block;
        if(owners.size)block=await network.block(height,routes);
        else block={height,hash:await network.hash(height),parent:parent||'',payments:[]};
        if(!block.hash || (parent && block.parent!==parent))throw new Error('Inconsistent block history');
        parent=block.hash;
        for(const p of block.payments){
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
      await c.query("update chains set last_scanned=$2,scan_ready_at=case when $2=$3::bigint then now() end where id=$1",[cid,end,head]);
      await c.query('delete from scanned_blocks where chain_id=$1 and height<$2',[cid,end-Math.max(256,chain.required_conf+40)]);
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
