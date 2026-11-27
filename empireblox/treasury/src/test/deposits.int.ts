import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { HDNodeWallet, id, zeroPadValue, toBeHex } from 'ethers';
import { buildServer } from '../api/server.js';
import { pool, query, tx } from '../db.js';
import { setSecret } from '../vault.js';
import { EvmWatcher } from '../chains/evm.js';
import { creditConfirmedDeposit } from '../ledger.js';
import { getOrCreateAddress } from '../derive.js';
import { publicCustodyFixture } from './custody-public-fixture.js';

const app = await buildServer(), watcher = new EvmWatcher('ETH');
const key = HDNodeWallet.fromSeed(randomBytes(32)).neuter();
const zero = '0x' + '00'.repeat(32), token = '0xdac17f958d2ee523a2206206994597c13d831ec7';
let head=104, forkAt=999, network='0x1', failHeight=-1, address='', cookie='', uid='', secondCookie='';
const hash = (n:number) => id('block-'+n+(n>=forkAt?'b':'a'));
const txHash = id('payment'), nativeHashes=[id('native transfer'),id('failed native transfer')];
const sender='0x'+'0a'.repeat(20);
function nativeTx(hash:string,index:number) {
  return {hash,from:sender,to:address,nonce:toBeHex(index),blockHash:hashAt118(),blockNumber:'0x76',transactionIndex:toBeHex(index),
    gas:'0x5208',gasPrice:'0x1',value:'0x' + (3000000000000000n).toString(16),input:'0x',type:'0x0',
    v:'0x1b',r:'0x'+'01'.repeat(32),s:'0x'+'02'.repeat(32)};
}
const hashAt118=()=>hash(118);
function rpc(method:string, p:any[]) {
  if (method==='eth_chainId') return network;
  if (method==='eth_blockNumber') return toBeHex(head);
  if(method==='eth_getTransactionReceipt'){
    const index=nativeHashes.indexOf(p[0]);
    if(index<0)return null;
    return {transactionHash:p[0],transactionIndex:toBeHex(index),blockHash:hashAt118(),blockNumber:'0x76',from:sender,to:address,
      contractAddress:null,cumulativeGasUsed:'0x5208',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[],logsBloom:'0x'+'00'.repeat(256),
      status:index===0?'0x1':'0x0',type:'0x0'};
  }
  if (method==='eth_getBlockByNumber') {
    const n=Number(p[0]);
    if (n===failHeight) return null;
    return { number:toBeHex(n),hash:hash(n),parentHash:hash(n-1),timestamp:toBeHex(Math.floor(Date.now()/1000)),
      nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x100000',gasUsed:'0x00', miner:'0x'+'01'.repeat(20),
      extraData:'0x', transactions:n===118 ? (p[1]?nativeHashes.map(nativeTx):nativeHashes):[],baseFeePerGas:'0x1' };
  }
  if (method==='eth_getLogs') {
    const n = [102,103].find(n=>hash(n)===p[0].blockHash);
    if (!address || !n || (forkAt<=102 ? n!==103 : n!==102)) return [];
    return [{address:token,blockHash:hash(n),blockNumber:toBeHex(n),transactionHash:txHash,logIndex:'0x0',
      transactionIndex:'0x0',removed:false,topics:[id('Transfer(address,address,uint256)'),zero,zeroPadValue(address,32)],
      data:zeroPadValue(toBeHex(1234567),32)}];
  }
  throw new Error('Unexpected RPC method '+method);
}
const server = createServer(async (req,res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const payload=JSON.parse(Buffer.concat(chunks).toString());
  const answer=(m:any)=>({jsonrpc:'2.0',id:m.id,result:rpc(m.method,m.params)});
  res.setHeader('content-type','application/json'); res.end(JSON.stringify(Array.isArray(payload)?payload.map(answer):answer(payload)));
});
const request=(url:string, session=cookie) => app.inject({method:'GET',url,headers:{cookie:session}});
async function register() {
  const name='w'+randomBytes(6).toString('hex');
  const r=await app.inject({method:'POST',url:'/api/auth/register',payload:{username:name,email:name+'@test.invalid',password:randomUUID()}});
  assert.equal(r.statusCode,200);
  return {uid:r.json().user.id,cookie:String(r.headers['set-cookie']).split(';')[0]!};
}
before(async()=>{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  ({uid,cookie}=await register()); secondCookie=(await register()).cookie;
});
after(async()=>{await app.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await pool.end(); });
test('wallet requires sign-in and withholds addresses until the monitor is ready',async()=>{
  assert.equal((await request('/api/me/address/ETH','')).statusCode,401);
  assert.equal((await request('/api/me/address/ETH')).statusCode,503);
  await setSecret('xpub:EVM',key.extendedKey,'test');
  await publicCustodyFixture(key.extendedKey);
  await setSecret('rpc:ETH','http://127.0.0.1:'+(server.address() as AddressInfo).port,'test');
  assert.equal((await request('/api/me/address/ETH')).statusCode,503);
  await watcher.tick();
});
test('parallel address requests agree per account and derive distinct addresses across accounts',async()=>{
  const replies=await Promise.all(Array.from({length:12},()=>request('/api/me/address/ETH')));
  assert.ok(replies.every(r=>r.statusCode===200));
  address=replies[0]!.json().address;
  const row=(await query('select deriv_index from deposit_addresses where user_id=$1 and chain_id=$2',[uid,'ETH'])).rows[0];
  assert.equal(address,key.derivePath('0/'+row.deriv_index).address.toLowerCase());
  assert.ok(replies.every(r=>r.json().address===address));
  const second=(await request('/api/me/address/ETH',secondCookie)).json().address;assert.match(second,/^0x[\da-f]{40}$/);assert.notEqual(second,address);
});
test('saves a supported currency server-side and restricts disabled deposit routes',async()=>{
  const put=(asset:string)=>app.inject({method:'PUT',url:'/api/me/currency',headers:{cookie},payload:{asset}});
  assert.equal((await put('USDT')).statusCode,200);
  assert.equal((await request('/api/auth/me')).json().user.display_ccy,'USDT');
  assert.equal((await put('USDT.ERC20')).statusCode,400);
  assert.equal((await put('BAD')).statusCode,400);
  await query("update chains set enabled=false where id='ETH'");
  assert.equal((await request('/api/me/address/ETH')).statusCode,503);
  assert.ok(!(await request('/api/assets')).json().assets.some((a:any)=>a.chain_id==='ETH'));
  await query("update chains set enabled=true where id='ETH'");
});
test('pausing blocks address issuance while issued addresses stay monitored through reorgs and credit once across replicas',async t=>{
  const active=(await request('/api/assets')).json();
  assert.equal(active.deposits_paused,false);
  assert.ok(active.directRoutes.some((a:any)=>a.id==='USDT.ERC20'&&a.available));
  await query("update settings set value='true' where key='deposits_paused'");
  t.after(async()=>{await query("update settings set value='false' where key='deposits_paused'");});
  assert.equal((await request('/api/me/address/ETH')).statusCode,503);
  await assert.rejects(getOrCreateAddress(uid,'ETH'),/unavailable/);
  const paused=await register();
  assert.equal((await request('/api/me/address/ETH',paused.cookie)).statusCode,503);
  await assert.rejects(getOrCreateAddress(paused.uid,'ETH'),/unavailable/);
  assert.equal((await query('select 1 from deposit_addresses where user_id=$1',[paused.uid])).rowCount,0);
  const catalog=(await request('/api/assets')).json();
  assert.equal(catalog.deposits_paused,true);
  for(const field of ['deposit_provider','oxapay_ready','merchant_configured','public_origin'])assert.equal(Object.hasOwn(catalog,field),false,field);
  assert.deepEqual(catalog.directRoutes.map((a:any)=>a.id).sort(),['BNB','ETH','POL','SOL','USDT.BEP20','USDT.ERC20','USDT.POL']);
  assert.ok(catalog.directRoutes.every((a:any)=>a.available===false));
  for(const asset of ['USDT','BTC','ETH','BNB','POL','SOL','TRX'])assert.ok(catalog.currencies.some((a:any)=>a.id===asset),asset);
  assert.equal((await app.inject({method:'PUT',url:'/api/me/currency',headers:{cookie},payload:{asset:'SOL'}})).statusCode,200);
  assert.equal((await request('/api/auth/me')).json().user.display_ccy,'SOL');
  head=105; await watcher.tick();
  const hist=async()=>(await request('/api/me/deposits?asset=USDT.ERC20')).json().deposits;
  assert.equal((await hist())[0].status,'pending');
  assert.equal((await hist())[0].amount,'1234567');
  const dep=(await query('select id from deposits where txid=$1',[txHash])).rows[0];
  assert.equal(await tx(c=>creditConfirmedDeposit(c,dep.id)),false);
  forkAt=102; await watcher.tick();
  assert.equal((await hist())[0].status,'orphaned');
  head=106; await watcher.tick();
  assert.equal((await hist())[0].status,'pending');
  assert.equal((await hist())[0].confirmations,4);
  head=120; await Promise.all([watcher.tick(),new EvmWatcher('ETH').tick()]);
  await watcher.tick();
  assert.equal((await hist()).length,1); assert.equal((await hist())[0].status,'credited');
  const balances=(await request('/api/me/balances')).json().balances;
  assert.equal(balances[0].amount,'1234567000000000000'); assert.equal(balances[0].decimals,18);
  assert.equal((await request('/api/me/deposits',secondCookie)).json().deposits.length,0);
  assert.equal((await query("select count(*) from journals where ref=$1",['deposit:'+dep.id])).rows[0].count,'1');
  assert.equal((await request('/api/me/address/ETH')).statusCode,503);
  assert.equal((await query("select address from deposit_addresses where user_id=$1 and chain_id='ETH'",[uid])).rows[0].address,address);
});
test('direct native payments need a successful receipt and use a separate event index',async()=>{
  head=134; await watcher.tick(); await watcher.tick();
  const native=(await query("select amount,status,log_index from deposits where user_id=$1 and asset_id='ETH'",[uid])).rows;
  assert.deepEqual(native,[{amount:'3000000000000000',status:'credited',log_index:-1}]);
});
test('incomplete blocks and wrong-network RPCs preserve the checkpoint',async()=>{
  const cursor=async()=>(await query("select last_scanned from chains where id='ETH'")).rows[0].last_scanned;
  const last=await cursor(); head++; failHeight=Number(last)+1;
  await assert.rejects(watcher.tick()); assert.equal(await cursor(),last);
  failHeight=-1; network='0x38'; await assert.rejects(watcher.tick()); assert.equal(await cursor(),last); network='0x1';
});
