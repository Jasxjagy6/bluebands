import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const runner=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(runner.hostname))throw Error('Disposable local database required');
const admin=new pg.Pool({connectionString:runner.href}),database='rpc_'+randomBytes(8).toString('hex');
const isolated=new URL(runner);isolated.pathname='/'+database;process.env.DATABASE_URL=isolated.href;
const {pool,query}=await import('../db.js');
const {setSecret}=await import('../vault.js');
const {getRpcConfig,createAlchemyFetch,createAlchemyEvmProvider,flushRpcFailure,failoverDrpc,clearAlchemyPauseWhenReady,reserveDrpcRequest}=await import('../chains/rpc.js');
type Endpoint=NonNullable<Awaited<ReturnType<typeof getRpcConfig>>>;
const originalFetch=globalThis.fetch;
async function respond(endpoint:Endpoint,status:number,body:unknown){
  globalThis.fetch=async()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  try{return await createAlchemyFetch(endpoint)(endpoint.url,{method:'POST',body:'{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'});}
  finally{globalThis.fetch=originalFetch;}
}

before(async()=>{
  await admin.query('create database '+database+' template template0');
  const directory=new URL('../../sql/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await query(await readFile(new URL(file,directory),'utf8'));
  await setSecret('drpc:API_KEY','fixture-drpc-primary-key','fixture');
  await setSecret('alchemy:API_KEY','fixture-alchemy-fallback-key','fixture');
  await setSecret('rpc:SOL','https://legacy.fixture.invalid/private','fixture');
});
beforeEach(async()=>{
  await query('update drpc_rpc_chain_health set cooldown_until=null,failures=0,last_error=null');
  await query('update alchemy_rpc_key_health set cooldown_until=null,failures=0');
  await query("update alchemy_rpc_state set active_provider='drpc',active_slot=1,deposits_paused=false,routing_epoch=0,changed_at=clock_timestamp() where singleton");
  await query('update alchemy_rpc_budget set tokens=60,updated_at=clock_timestamp()');
  await query('update drpc_rpc_budget set tokens=1,updated_at=clock_timestamp()');
});
after(async()=>{
  globalThis.fetch=originalFetch;await pool.end();
  try{await admin.query('drop database if exists '+database);}finally{await admin.end();}
});

test('Solana scanners and sweepers select Alchemy directly even when dRPC is configured and healthy',async()=>{
  assert.equal((await getRpcConfig('SOL'))?.provider,'alchemy');
  for(const chain of ['ETH','BSC','POL'])assert.equal((await getRpcConfig(chain))?.provider,'drpc');
});

test('concurrent dRPC callers share one paced request budget without consuming the Alchemy allowance',async()=>{
  const start=performance.now();await Promise.all(Array.from({length:8},()=>reserveDrpcRequest()));
  assert.ok(performance.now()-start>=1600,'eight callers must not each reuse a per-process burst');
  const tokens=Number((await query('select tokens from drpc_rpc_budget')).rows[0].tokens);
  assert.ok(tokens>=0&&tokens<=1);
  assert.equal(Number((await query('select tokens from alchemy_rpc_budget')).rows[0].tokens),60);
});

test('a missing shared dRPC budget fails closed instead of sending without pacing',async()=>{
  await query('delete from drpc_rpc_budget');
  try{await assert.rejects(reserveDrpcRequest(),/budget unavailable/);}
  finally{await query('insert into drpc_rpc_budget(singleton) values(true)');}
});

test('RPC pacing remains available when address requests occupy the entire application connection pool',async()=>{
  const clients=await Promise.all(Array.from({length:10},()=>pool.connect()));
  let timer:ReturnType<typeof setTimeout>|undefined;
  const pending=reserveDrpcRequest();
  try{await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Scanner pacing was starved by the application pool')),1000);})]);}
  finally{clearTimeout(timer);for(const client of clients)client.release();await pending;}
});

test('dRPC HTTP 400 plan restrictions fail over only the affected network and retry the primary after cooldown',async()=>{
  const endpoint=(await getRpcConfig('POL'))!;
  assert.equal(endpoint.provider,'drpc');
  const response=await respond(endpoint,400,{jsonrpc:'2.0',id:1,error:{code:35,message:'chain is not available on free plan, please upgrade to paid plan'}});
  assert.equal(response.status,400);
  assert.equal((await getRpcConfig('POL'))?.provider,'alchemy');
  for(const chain of ['ETH','BSC'])assert.equal((await getRpcConfig(chain))?.provider,'drpc');
  const health=(await query("select failures,last_error,cooldown_until>clock_timestamp()+interval '25 minutes' as long_cooldown from drpc_rpc_chain_health where chain_id='POL'")).rows[0];
  assert.equal(health.failures,1);assert.equal(health.last_error,'unsupported');assert.equal(health.long_cooldown,true);
  assert.equal((await query('select deposits_paused from alchemy_rpc_state')).rows[0].deposits_paused,true);
  await query("update drpc_rpc_chain_health set cooldown_until=clock_timestamp()-interval '1 second' where chain_id='POL'");
  // The old global fallback state must not strand a recovered primary.
  await query("update alchemy_rpc_state set active_provider='alchemy'");
  assert.equal((await getRpcConfig('POL'))?.provider,'drpc');
});

test('malformed dRPC replies fail over, while request-specific JSON-RPC errors retain the primary',async()=>{
  const endpoint=(await getRpcConfig('ETH'))!;
  await respond(endpoint,400,{jsonrpc:'2.0',id:1,error:{code:-32602,message:'Invalid params'}});
  assert.equal((await getRpcConfig('ETH'))?.provider,'drpc');
  await respond(endpoint,200,{unexpected:'response'});
  assert.equal((await getRpcConfig('ETH'))?.provider,'alchemy');
});

test('concurrent dRPC failures cool a route once and preserve the routing epoch for other stale failures',async()=>{
  const epoch=(await query('select routing_epoch from alchemy_rpc_state')).rows[0].routing_epoch;
  const results=await Promise.all(Array.from({length:6},()=>failoverDrpc('BSC','throttle')));
  assert.equal(results.filter(Boolean).length,1);
  const state=(await query('select routing_epoch from alchemy_rpc_state')).rows[0];
  assert.equal(BigInt(state.routing_epoch),BigInt(epoch)+1n);
  assert.equal((await query("select failures from drpc_rpc_chain_health where chain_id='BSC'")).rows[0].failures,1);
});

test('recurring dRPC throttles back off long enough for fallback scans to commit instead of retrying the primary every batch',async()=>{
  for(let attempt=0;attempt<8;attempt++){
    await query("update drpc_rpc_chain_health set cooldown_until=null where chain_id='BSC'");
    assert.equal(await failoverDrpc('BSC','throttle'),true);
    const row=(await query("select extract(epoch from (cooldown_until-clock_timestamp())) as seconds from drpc_rpc_chain_health where chain_id='BSC'")).rows[0];
    const expected=Math.min(900,15*2**attempt);
    assert.ok(Number(row.seconds)>expected-2&&Number(row.seconds)<=expected);
  }
});

test('a throttled scanner finishes catch-up on fallback before returning to dRPC, and retains primary availability if fallback is cooling',async()=>{
  await query("update chains set scan_ready_at=null where id='BSC'");
  await failoverDrpc('BSC','throttle');
  await query("update drpc_rpc_chain_health set cooldown_until=clock_timestamp()-interval '1 second' where chain_id='BSC'");
  assert.equal((await getRpcConfig('BSC'))?.provider,'alchemy');
  await query("update alchemy_rpc_key_health set cooldown_until=clock_timestamp()+interval '1 minute' where slot=1");
  assert.equal((await getRpcConfig('BSC'))?.provider,'drpc','a healthy primary remains usable when fallback cannot serve recovery');
  await query('update alchemy_rpc_key_health set cooldown_until=null where slot=1');
  await query("update chains set scan_ready_at=clock_timestamp() where id='BSC'");
  assert.equal((await getRpcConfig('BSC'))?.provider,'drpc');
});

test('exhausted fallback credentials cannot bypass a cooling dRPC route through legacy endpoints',async()=>{
  await failoverDrpc('SOL');
  await query("update alchemy_rpc_key_health set cooldown_until=clock_timestamp()+interval '5 minutes' where slot=1");
  assert.equal(await getRpcConfig('SOL'),null);
  assert.equal((await getRpcConfig('ETH'))?.provider,'drpc');
});

test('a caller abort during local Alchemy queuing does not cool down a healthy credential',async()=>{
  await failoverDrpc('SOL');
  const endpoint=(await getRpcConfig('SOL'))!;
  const abort=new AbortController();abort.abort();
  await assert.rejects(createAlchemyFetch(endpoint)(endpoint.url,{method:'POST',body:'{"method":"getSlot"}',signal:abort.signal}));
  assert.equal((await query('select failures from alchemy_rpc_key_health where slot=1')).rows[0].failures,0);
});

test('scanner failover waits until chain locks are released instead of blocking address issuance',async()=>{
  const scanner=await pool.connect(),issuance=await pool.connect();
  let endpoint:Endpoint|undefined;
  try{
    await scanner.query('begin');await scanner.query("select id from chains where id='ETH' for update");
    endpoint=(await getRpcConfig('ETH',scanner))!;
    await issuance.query('begin');await issuance.query('select singleton from alchemy_rpc_state where singleton for share');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([respond(endpoint,503,{error:{code:-32000,message:'upstream unavailable'}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('RPC failure waited on issuance while retaining the chain lock')),1000);})]);
    }finally{clearTimeout(timer);}
    assert.equal((await getRpcConfig('ETH'))?.provider,'drpc','no routing write occurs inside the scan');
    await scanner.query('rollback');await issuance.query('rollback');
    await flushRpcFailure(endpoint);
    assert.equal((await getRpcConfig('ETH'))?.provider,'alchemy');
  }finally{
    await scanner.query('rollback');await issuance.query('rollback');scanner.release();issuance.release();
  }
});

test('EVM transport recognizes JSON-RPC plan errors in HTTP 400 responses',async()=>{
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,error:{code:35,message:'chain is not available on free plan'}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=(await getRpcConfig('BSC'))!;
  const provider=createAlchemyEvmProvider({...endpoint,url:'http://127.0.0.1:'+(server.address() as AddressInfo).port});
  try{
    await assert.rejects(provider.send('eth_blockNumber',[]));
    assert.equal((await getRpcConfig('BSC'))?.provider,'alchemy');
  }finally{provider.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('provider pause clears only after every enabled scanner renews its checkpoint',async()=>{
  await query("update chains set enabled=id in ('ETH','BSC','POL','SOL'),scan_ready_at=clock_timestamp()-interval '3 minutes'");
  await failoverDrpc('SOL');
  await query("update chains set scan_ready_at=clock_timestamp() where id in ('ETH','BSC','POL')");
  await clearAlchemyPauseWhenReady();
  assert.equal((await query('select deposits_paused from alchemy_rpc_state')).rows[0].deposits_paused,true);
  await query("update chains set scan_ready_at=clock_timestamp() where id='SOL'");
  await clearAlchemyPauseWhenReady();
  assert.equal((await query('select deposits_paused from alchemy_rpc_state')).rows[0].deposits_paused,false);
});
