import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import type {AddressInfo} from 'node:net';
import { HDNodeWallet,id,toBeHex } from 'ethers';
import { ed25519 } from '@noble/curves/ed25519';
import { base58,bech32,base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
import { associatedTokenAccount,receiveAddress,validSolOwner,TOKEN_PROGRAM } from '../chains/receive.js';

// Legacy issuance is permanently closed after managed enrollment. Keep these
// historical-address fixtures separate from the managed-wallet test database.
const runner=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(runner.hostname))throw Error('Disposable local database required');
const admin=new pg.Pool({connectionString:runner.href}),database='legacy_networks_'+randomBytes(8).toString('hex');
const isolated=new URL(runner);isolated.pathname='/'+database;process.env.DATABASE_URL=isolated.href;
const {pool,query}=await import('../db.js');
const {getOrCreateAddress}=await import('../derive.js');
const {setSecret}=await import('../vault.js');
const {NonEvmWatcher,bitcoinPayments}=await import('../chains/non-evm.js');

const uid=randomUUID(), xpub=HDNodeWallet.fromSeed(randomBytes(32)).neuter().extendedKey;
const owner=base58.encode(ed25519.getPublicKey(randomBytes(32))),mint='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const addresses:Record<string,string>={}, heights:Record<string,number>={BTC:100,SOL:100,TRON:100};
const hash=(id:string,n:number)=>id==='SOL'?base58.encode(sha256(Buffer.from(id+n))):id+n;
const solProbe=base58.encode(Buffer.alloc(64,201)),solPayment=base58.encode(Buffer.alloc(64,202)),solFailed=base58.encode(Buffer.alloc(64,203));
const solTipProbe=base58.encode(Buffer.alloc(64,200)),solPayer=base58.encode(Buffer.alloc(32,27));
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
    if(b.method==='getFirstAvailableBlock'||b.method==='minimumLedgerSlot')return 90;
    if(b.method==='getSignaturesForAddress'){
      const sigs=b.params[0]===solPayer?[solProbe]:b.params[0]==='11111111111111111111111111111111'?[]:head>=102?[solPayment,solFailed]:[];
      const after=b.params[1].before?sigs.indexOf(b.params[1].before)+1:0;
      return sigs.slice(after,after+b.params[1].limit).map(signature=>({signature,slot:signature===solProbe?100:102,
        err:signature===solFailed?{InstructionError:[0,'failed']}:null,confirmationStatus:'finalized'}));
    }
    if(b.method==='getSignatureStatuses')return {context:{slot:head},value:[{slot:100,err:null,confirmationStatus:'finalized'}]};
    if(b.method==='getTransaction'){
      assert.equal(b.params[1].maxSupportedTransactionVersion,1);assert.equal(b.params[1].encoding,'jsonParsed');
      const signature=b.params[0],ata=associatedTokenAccount(owner,mint);
      if(signature===solProbe||signature===solTipProbe)return {slot:signature===solProbe?100:head,version:1,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:solPayer}],instructions:[]}},meta:{err:null,postTokenBalances:[],innerInstructions:[]}};
      const parsed={type:'transferChecked',info:{destination:ata,source:'other',mint,tokenAmount:{amount:'2000000'}}};
      const sol={programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:'other',destination:owner,lamports:1234567}}};
      return {slot:102,version:1,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:ata},{pubkey:owner}],instructions:[sol,{programId:'wrapper'}]}},
        meta:{err:signature===solFailed?{InstructionError:[0,'failed']}:null,postTokenBalances:[{owner,mint,accountIndex:0}],innerInstructions:signature===solFailed?null:[{index:1,instructions:[{programId:TOKEN_PROGRAM,parsed}]}]}};
    }
    if(b.method==='getBlock'){
      const n=b.params[0];assert.notEqual(n,101);assert.equal(b.params[1].transactionDetails,'signatures');
      return {blockhash:hash(net,n),blockTime:Math.floor(Date.now()/1000),signatures:(n===head?[solTipProbe]:[]).concat(n===100?[solProbe]:n===102?[solPayment,solFailed]:[])};
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
  await admin.query('create database '+database+' template template0');
  const sql=new URL('../../sql/',import.meta.url);
  for(const f of (await readdir(sql)).filter(f=>f.endsWith('.sql')).sort())await query(await readFile(new URL(f,sql),'utf8'));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  await query("insert into users(id,username,email,pass_hash) values($1,$2,$3,'x')",[uid,'n'+randomBytes(4).toString('hex'),uid+'@test.invalid']);
  for(const net of ['BTC','SOL','TRON']){
    await query('update chains set enabled=true,required_conf=2 where id=$1',[net]);
    await setSecret('rpc:'+net,'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/'+net,'fixture');
    if(net!=='SOL')await setSecret('xpub:'+net,xpub,'fixture');
  }
});
after(async()=>{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();
  try{await admin.query('drop database if exists '+database);}finally{await admin.end();}
});
test('network identity must match before issuing any addresses',async()=>{
  wrongNetwork=true;
  for(const net of ['BTC','SOL','TRON']){await assert.rejects(new NonEvmWatcher(net).tick()); await assert.rejects(getOrCreateAddress(uid,net));}
  wrongNetwork=false;
});
test('legacy assignments remain monitored without offering new off-scope deposit addresses',async()=>{
  assert.ok(validSolOwner(owner));assert.equal(validSolOwner('11111111111111111111111111111111'),false);
  for(const net of ['BTC','SOL','TRON']){
    await new NonEvmWatcher(net).tick();
    addresses[net]=net==='SOL'?owner:receiveAddress(net==='BTC'?'btc':'tron',xpub,101);
    await query('insert into deposit_addresses(chain_id,user_id,address,deriv_index) values($1,$2,$3,101)',[net,uid,addresses[net]]);
    if(net==='SOL')assert.equal((await getOrCreateAddress(uid,net)).address,owner);else await assert.rejects(getOrCreateAddress(uid,net),/unavailable/);
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
test('BTC and TRON refuse to bootstrap existing addresses without a scan cursor',async()=>{
  for(const net of ['BTC','TRON']){
    const last=(await query('select last_scanned from chains where id=$1',[net])).rows[0].last_scanned;
    await query('update chains set last_scanned=0,scan_ready_at=null where id=$1',[net]);
    try{
      await assert.rejects(new NonEvmWatcher(net).tick(),/Existing deposit addresses require history reconciliation/);
      assert.equal((await query('select last_scanned from chains where id=$1',[net])).rows[0].last_scanned,'0');
    }finally{await query('update chains set last_scanned=$2,scan_ready_at=clock_timestamp() where id=$1',[net,last]);}
  }
});
