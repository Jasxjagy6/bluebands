import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import type {AddressInfo} from 'node:net';
import { HDNodeWallet,id,toBeHex } from 'ethers';
import { ed25519 } from '@noble/curves/ed25519';
import { base58,bech32,base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { pool,query } from '../db.js';
import { getOrCreateAddress } from '../derive.js';
import { setSecret } from '../vault.js';
import { NonEvmWatcher,bitcoinPayments } from '../chains/non-evm.js';
import { associatedTokenAccount,validSolOwner,TOKEN_PROGRAM } from '../chains/receive.js';

const uid=randomUUID(), xpub=HDNodeWallet.fromSeed(randomBytes(32)).neuter().extendedKey;
const owner=base58.encode(ed25519.getPublicKey(randomBytes(32))),mint='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const addresses:Record<string,string>={}, heights:Record<string,number>={BTC:100,SOL:100,TRON:100};
const hash=(id:string,n:number)=>id+n;
const tronToken='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const trxHex=(a:string)=>Buffer.from(base58check(sha256).decode(a)).toString('hex');
let wrongNetwork=false,missingReceipt=false;
async function fixture(net:string,route:string,b:any){
  const head=heights[net]!;
  if(net==='BTC'){
    if(b.method==='getblockchaininfo')return {chain:wrongNetwork?'test':'main',blocks:head,initialblockdownload:false};
    if(b.method==='getblockhash')return b.params[0]===0?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':hash(net,b.params[0]);
    if(b.method==='getblock'){
      const n=Number(b.params[0].slice(3));
      return {height:n,hash:hash(net,n),previousblockhash:hash(net,n-1),tx:n===101?[{txid:id('btc-payment'),vin:[{}],vout:[{n:1,value:0.00012345,scriptPubKey:{address:addresses.BTC}},{n:2,value:0.00000001,scriptPubKey:{address:addresses.BTC}}]}]:[]};
    }
  }
  if(net==='SOL'){
    if(b.method==='getGenesisHash')return wrongNetwork?'testnet':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    if(b.method==='getSlot')return head;
    if(b.method==='getBlocks')return Array.from({length:b.params[1]-b.params[0]+1},(_,i)=>b.params[0]+i).filter(n=>n!==101);
    if(b.method==='getBlock'){
      const n=b.params[0], ata=associatedTokenAccount(owner,mint);
      const parsed={type:'transferChecked',info:{destination:ata,source:'other',mint,tokenAmount:{amount:'2000000'}}};
      const sol={programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:'other',destination:owner,lamports:1234567}}};
      const tx={transaction:{signatures:[base58.encode(randomBytes(64))],message:{accountKeys:[{pubkey:ata}],instructions:[sol,{programId:'wrapper'}]}},
        meta:{err:null,postTokenBalances:[{owner,mint,accountIndex:0}],innerInstructions:[{index:1,instructions:[{programId:TOKEN_PROGRAM,parsed}]}]}};
      return {blockhash:hash(net,n),previousBlockhash:hash(net,n===102?100:n-1),transactions:n===102?[tx,{...tx,meta:{...tx.meta,err:'failed'}}]:[]};
    }
  }
  if(net==='TRON'){
    if(b.method==='eth_chainId')return wrongNetwork?'0x1':'0x2b6653dc';
    if(route.endsWith('/getnowblock'))return {block_header:{raw_data:{number:head}}};
    if(route.endsWith('/getblockbynum')){
      const n=b.num,transactions:any[]=[];
      if(n===101){
        const transfer={type:'TransferContract',parameter:{value:{amount:1234567,to_address:trxHex(addresses.TRON!)}}};
        transactions.push({txID:id('trx'),ret:missingReceipt?[]:[{contractRet:'SUCCESS'}],raw_data:{contract:[transfer]}},
          {txID:id('trx reverted'),ret:[{contractRet:'REVERT'}],raw_data:{contract:[transfer]}},
          {txID:id('trc'),ret:[{contractRet:'SUCCESS'}],raw_data:{contract:[{type:'TriggerSmartContract'}]}});
      }
      return {blockID:hash(net,n),block_header:{raw_data:{number:n,parentHash:hash(net,n-1)}},transactions};
    }
    if(route.endsWith('/gettransactioninfobyblocknum')){
      if(missingReceipt)return [];
      return [{id:id('trc'),blockNumber:101,receipt:{result:'SUCCESS'},log:[{address:trxHex(tronToken).slice(2),
        topics:[id('Transfer(address,address,uint256)').slice(2),'0'.repeat(64),trxHex(addresses.TRON!).slice(2).padStart(64,'0')],data:toBeHex(2345678,32).slice(2)}]}];
    }
  }
  throw new Error('Unexpected fixture method');
}
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const part of req)chunks.push(part);
    const body=JSON.parse(Buffer.concat(chunks).toString()),route=req.url!,net=route.split('/')[1]!;
    const value=await fixture(net,route,body);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(body.method?{result:value,id:body.id,jsonrpc:'2.0'}:value));
  }catch{res.writeHead(500);res.end();}
});
before(async()=>{
  await query("update settings set value=to_jsonb('direct'::text) where key='deposit_provider'");
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  await query("insert into users(id,username,email,pass_hash) values($1,$2,$3,'x')",[uid,'n'+randomBytes(4).toString('hex'),uid+'@test.invalid']);
  for(const net of ['BTC','SOL','TRON']){
    await query('update chains set enabled=true,required_conf=2 where id=$1',[net]);
    await setSecret('rpc:'+net,'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/'+net,'fixture');
    if(net!=='SOL')await setSecret('xpub:'+net,xpub,'fixture');
  }
});
after(async()=>{await query("update settings set value=to_jsonb('oxapay'::text) where key='deposit_provider'");await query("update chains set enabled=false where id in ('BTC','SOL','TRON')");server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();});
test('network identity must match before issuing any addresses',async()=>{
  wrongNetwork=true;
  for(const net of ['BTC','SOL','TRON']){await assert.rejects(new NonEvmWatcher(net).tick()); await assert.rejects(getOrCreateAddress(uid,net));}
  wrongNetwork=false;
});
test('watch-only derivation and Solana receive-pool exhaustion fail closed',async()=>{
  assert.ok(validSolOwner(owner));assert.equal(validSolOwner('11111111111111111111111111111111'),false);
  for(const net of ['BTC','SOL','TRON']){
    await new NonEvmWatcher(net).tick();
    if(net==='SOL'){await assert.rejects(getOrCreateAddress(uid,net));await query('insert into sol_receive_pool(address) values($1)',[owner]);}
    const first=await getOrCreateAddress(uid,net),again=await getOrCreateAddress(uid,net);
    assert.deepEqual(again,first);addresses[net]=first.address;
  }
  assert.equal(bech32.decode(addresses.BTC! as `${string}1${string}`).prefix,'bc');assert.equal(addresses.SOL,owner);assert.equal(trxHex(addresses.TRON!).slice(0,2),'41');
});
test('Bitcoin preserves satoshis, ignores dust, and credits a confirmed output once',async()=>{
  const w=new NonEvmWatcher('BTC');heights.BTC=101;await w.tick();
  const snap=async()=>(await query("select amount,status from deposits where user_id=$1 and chain_id='BTC'",[uid])).rows;
  assert.deepEqual(await snap(),[{amount:'12345',status:'pending'}]);
  heights.BTC=102;await Promise.all([w.tick(),new NonEvmWatcher('BTC').tick()]);await w.tick();
  assert.deepEqual(await snap(),[{amount:'12345',status:'credited'}]);
  const r=bitcoinPayments({tx:[{txid:'tiny',vin:[{}],vout:[{n:1,value:'1e-8',scriptPubKey:{address:'dest'}}]}]},
    {owners:new Map([['dest',uid]]),native:'BTC',tokens:new Map()});
  assert.equal(r[0]!.amount,1n);
});
test('Solana handles skipped slots, finalized SOL, inner SPL transfers and failed transactions',async()=>{
  const w=new NonEvmWatcher('SOL');heights.SOL=102;await w.tick();heights.SOL=103;await w.tick();
  const rows=(await query("select asset_id,amount,status from deposits where user_id=$1 and chain_id='SOL' order by asset_id",[uid])).rows;
  assert.deepEqual(rows,[{asset_id:'SOL',amount:'1234567',status:'credited'},{asset_id:'USDT.SPL',amount:'2000000',status:'credited'}]);
});
test('TRON rejects incomplete transaction status, then credits solidified TRX and excludes the unsupported USDT route',async()=>{
  const w=new NonEvmWatcher('TRON');heights.TRON=101;missingReceipt=true;await assert.rejects(w.tick());
  assert.equal((await query("select last_scanned from chains where id='TRON'")).rows[0].last_scanned,'100');
  missingReceipt=false;await w.tick();heights.TRON=102;await w.tick();
  const rows=(await query("select asset_id,amount,status from deposits where user_id=$1 and chain_id='TRON' order by asset_id",[uid])).rows;
  assert.deepEqual(rows,[{asset_id:'TRX',amount:'1234567',status:'credited'}]);
});
