import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHmac, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const runner=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(runner.hostname))throw Error('Disposable local database required');
const admin=new pg.Pool({connectionString:runner.href}),name='custody_api_'+randomBytes(8).toString('hex');
const isolated=new URL(runner);isolated.pathname='/'+name;process.env.DATABASE_URL=isolated.href;
const {query,pool}=await import('../db.js');
const {buildServer}=await import('../api/server.js');
const {encryptBlob,getSecret,setSecret}=await import('../vault.js');
const {alchemyRpcUrl,createAlchemyFetch,drpcRpcUrl,getRpcConfig,getRpcEndpoint,reserveAlchemyCu}=await import('../chains/rpc.js');
const {signAdminToken}=await import('../authutil.js');
const {provisionCustodyKeys}=await import('../custody/keys.js');
const temp=await mkdtemp(join(tmpdir(),'custody-api-'));
process.env.CUSTODY_KEY_DIR=join(temp,'private');
const app=await buildServer(),path='/api/admin/custody';
const destination='0x'+'b2'.repeat(20),rpc='https://rpc.test.invalid/private-credential';
const alchemyKey='fixture-alchemy-api-key-0123456789';
const factorKey='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
let keyId='',spki='',operatorCount=0;

function code(offset=0){
  const step=Buffer.alloc(8);step.writeBigInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
  const h=createHmac('sha1','12345678901234567890').update(step).digest(),at=h[19]!&15;
  return String((h.readUInt32BE(at)&0x7fffffff)%1000000).padStart(6,'0');
}
async function operator(twoFactor=true){
  const b=encryptBlob(factorKey);
  const {rows:[a]}=await query(`insert into admin_users(username,pass_hash,totp_enabled,totp_dek,totp_iv,totp_tag,totp_secret_enc)
    values($1,'fixture',$2,$3,$4,$5,$6) returning id`,['custody_fixture_'+ ++operatorCount,twoFactor,b.enc_dek,b.iv,b.tag,b.ciphertext]);
  return 'eb_admin='+await signAdminToken(Number(a.id));
}
const get=(cookie='')=>app.inject({url:path,headers:{cookie}});
const put=(cookie:string,body:Record<string,unknown>,id='ETH')=>app.inject({method:'PUT',url:path+'/networks/'+id,headers:{cookie},payload:body});
const putAlchemy=(cookie:string,body:Record<string,unknown>)=>app.inject({method:'PUT',url:path+'/alchemy',headers:{cookie},payload:body});

before(async()=>{
  await admin.query('create database '+name+' template template0');
  const sql=new URL('../../sql/',import.meta.url);
  for(const f of (await readdir(sql)).filter(f=>f.endsWith('.sql')).sort())await query(await readFile(new URL(f,sql),'utf8'));
  await provisionCustodyKeys();
  const k=(await query('select * from custody_public_key')).rows[0];keyId=k.key_id;spki=k.spki;
});
after(async()=>{
  await app.close();await pool.end();
  try{await admin.query('drop database if exists '+name);}
  finally{await admin.end();await rm(temp,{recursive:true,force:true});}
});

test('custody status uses the migrated schema, is private and exposes only the seven launch routes',async()=>{
  assert.equal((await get()).statusCode,401);
  const r=await get(await operator(false));assert.equal(r.statusCode,200,r.body);
  assert.equal(r.headers['cache-control'],'no-store');
  const d=r.json();assert.equal(d.deposits_paused,false);assert.equal(d.key.configured,false);assert.equal(d.key.ready,false);
  assert.equal(d.alchemy_configured,false);
  for(const field of ['deposit_provider','oxapay_ready','merchant_configured','public_origin'])assert.equal(Object.hasOwn(d,field),false,field);
  assert.deepEqual(d.networks.map((n:any)=>n.id).sort(),['BSC','ETH','POL','SOL']);
  assert.deepEqual(d.networks.flatMap((n:any)=>n.assets.map((a:any)=>a.id)).sort(),['BNB','ETH','POL','SOL','USDT.BEP20','USDT.ERC20','USDT.POL']);
  assert.ok(d.networks.every((n:any)=>n.sweeps_enabled===false&&n.ready===false&&n.rpc_configured===false));
  assert.doesNotMatch(r.body,/sealed_seed|wrap_spki|totp_secret_enc|signed_bytes/);
  assert.equal((await put(await operator(false),{enabled:false,totp:code()})).statusCode,403);
});

test('one encrypted Alchemy key configures documented mainnet endpoints and can be removed with fresh TOTP',async()=>{
  const who=await operator(),headers={cookie:who};
  await setSecret('rpc:ETH',rpc,'fixture');
  await query("insert into scanned_blocks(chain_id,height,hash) select id,100,'alchemy-before-key' from chains where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
  await query("update chains set last_scanned=100,scan_ready_at=clock_timestamp() where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
  for(const api_key of ['short','bad key format'])assert.equal((await putAlchemy(who,{api_key,totp:code(-1)})).statusCode,400);
  assert.equal((await putAlchemy(who,{api_key:alchemyKey,totp:code(4)})).statusCode,403);
  const saved=await putAlchemy(who,{api_key:alchemyKey,totp:code(-1)});assert.equal(saved.statusCode,200,saved.body);
  assert.equal(await getSecret('alchemy:API_KEY'),alchemyKey);
  assert.equal(await getSecret('rpc:ETH'),rpc);
  assert.deepEqual(['ETH','BSC','POL','SOL'].map(id=>alchemyRpcUrl(id,alchemyKey)),[
    `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    `https://bnb-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`,
  ]);
  assert.equal(alchemyRpcUrl('ETH','api/key?one#two'),'https://eth-mainnet.g.alchemy.com/v2/api%2Fkey%3Fone%23two');
  for(const [id,network] of Object.entries({ETH:'eth-mainnet',BSC:'bnb-mainnet',POL:'polygon-mainnet',SOL:'solana-mainnet'}))
    assert.equal(await getRpcEndpoint(id),`https://${network}.g.alchemy.com/v2/${alchemyKey}`);
  const status=await get(who),d=status.json();assert.equal(d.alchemy_configured,true);
  assert.ok(d.networks.every((n:any)=>n.rpc_configured===true&&n.scan_ready===false&&n.last_scanned==='100'));
  assert.ok(!status.body.includes(alchemyKey));
  const secrets=await app.inject({url:'/api/admin/secrets',headers});assert.equal(secrets.statusCode,200);assert.ok(!secrets.body.includes(alchemyKey));
  const stored=await query("select encode(ciphertext,'escape') as ciphertext from secrets where name='alchemy:API_KEY'");
  assert.ok(!stored.rows[0].ciphertext.includes(alchemyKey));
  assert.equal((await query("select detail from audit_log where action='custody.alchemy_rpc'")).rows[0].detail.configured,true);
  assert.equal((await putAlchemy(who,{api_key:alchemyKey,totp:code(-1)})).statusCode,403);
  const removed=await putAlchemy(who,{api_key:null,totp:code()});assert.equal(removed.statusCode,200,removed.body);
  assert.equal(await getSecret('alchemy:API_KEY'),null);assert.equal(await getRpcEndpoint('ETH'),rpc);
  assert.equal((await get(who)).json().alchemy_configured,false);
});

test('dRPC is primary, Alchemy fallback slots rotate safely, and the CU budget is shared',async()=>{
  const drpcKey='fixture-drpc-api-key-0123456789',fallbackOne='fixture-alchemy-fallback-one-012345',fallbackTwo='fixture-alchemy-fallback-two-012345';
  const putDrpc=async(api_key:string|null)=>app.inject({method:'PUT',url:path+'/drpc',headers:{cookie:await operator()},payload:{api_key,totp:code()}});
  const addAlchemy=async(api_key:string)=>app.inject({method:'POST',url:path+'/alchemy/keys',headers:{cookie:await operator()},payload:{api_key,totp:code()}});
  const removeAlchemy=async(slot:number)=>app.inject({method:'DELETE',url:path+'/alchemy/keys/'+slot,headers:{cookie:await operator()},payload:{totp:code()}});
  const primary=await putDrpc(drpcKey);assert.equal(primary.statusCode,200,primary.body);
  assert.equal((await getRpcConfig('ETH'))?.provider,'drpc');
  for(const [key,slot] of [[fallbackOne,1],[fallbackTwo,2]] as const){
    const added=await addAlchemy(key);assert.equal(added.statusCode,200,added.body);assert.equal(added.json().slot,slot);
  }
  assert.equal((await addAlchemy(fallbackOne)).statusCode,409,'duplicate fallback keys do not occupy a standby slot');
  const fallbackKeys=[fallbackOne,fallbackTwo];
  for(let slot=3;slot<=10;slot++){
    const key=`fixture-alchemy-fallback-${slot}-0123456789`;
    const added=await addAlchemy(key);assert.equal(added.statusCode,200,added.body);assert.equal(added.json().slot,slot);fallbackKeys.push(key);
  }
  assert.equal((await addAlchemy('fixture-alchemy-overflow-key-012345')).statusCode,409,'the pool rejects an eleventh key');
  assert.equal(await getSecret('alchemy:API_KEY'),fallbackOne);assert.equal(await getSecret('alchemy:API_KEY:2'),fallbackTwo);
  assert.equal(await getRpcEndpoint('BSC'),drpcRpcUrl('BSC',drpcKey));
  const primaryEndpoint=(await getRpcConfig('ETH'))!;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('',{status:429});
  try{
    const response=await createAlchemyFetch(primaryEndpoint)(primaryEndpoint.url,{method:'POST',body:'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'});
    assert.equal(response.status,429);
  }finally{globalThis.fetch=originalFetch;}
  const first=await getRpcConfig('ETH');assert.equal(first?.provider,'alchemy');assert.equal(first?.url,alchemyRpcUrl('ETH',fallbackOne));assert.equal(first?.slot,1);
  const failingEndpoint=first!,fetchBeforeThrottle=globalThis.fetch;
  globalThis.fetch=async()=>new Response('',{status:429});
  try{
    const response=await createAlchemyFetch(failingEndpoint)(failingEndpoint.url,{method:'POST',body:'{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'});
    assert.equal(response.status,429);
  }finally{globalThis.fetch=fetchBeforeThrottle;}
  assert.equal((await getRpcConfig('ETH'))?.slot,2);
  const status=await get(await operator()),d=status.json();assert.equal(d.rpc_provider,'mixed');assert.equal(d.alchemy_key_count,10);
  assert.equal(d.networks.find((n:any)=>n.id==='ETH').rpc_provider,'alchemy');
  assert.equal(d.networks.find((n:any)=>n.id==='BSC').rpc_provider,'drpc');
  assert.equal(d.alchemy_active_slot,2);assert.equal(d.provider_paused,true);assert.ok(!status.body.includes(drpcKey));
  for(const key of fallbackKeys)assert.ok(!status.body.includes(key));
  const secretList=await app.inject({url:'/api/admin/secrets',headers:{cookie:await operator()}});
  assert.ok(!secretList.body.includes('drpc:API_KEY'));assert.ok(!secretList.body.includes('alchemy:API_KEY'));
  const removed=await removeAlchemy(2);assert.equal(removed.statusCode,200,removed.body);
  assert.equal(await getSecret('alchemy:API_KEY:2'),null);assert.equal((await getRpcConfig('ETH'))?.slot,3,'removing an active key skips other cooled-down keys');
  for(const slot of [1,3,4,5,6,7,8,9,10])assert.equal((await removeAlchemy(slot)).statusCode,200,`remove fallback ${slot}`);
  assert.equal(await getRpcConfig('ETH'),null,'a cooling configured provider must not bypass to a legacy endpoint');
  await query("update drpc_rpc_chain_health set cooldown_until=clock_timestamp()-interval '1 second' where chain_id='ETH'");
  assert.equal((await getRpcConfig('ETH'))?.provider,'drpc');

  await query('update alchemy_rpc_budget set tokens=60,updated_at=clock_timestamp() where singleton');
  await assert.rejects(reserveAlchemyCu(61),/throughput budget/);
  const start=performance.now();await Promise.all([reserveAlchemyCu(60),reserveAlchemyCu(60),reserveAlchemyCu(60)]);
  assert.ok(performance.now()-start>=900,'concurrent requests share a 120-CU/s refill rather than reuse per-key tokens');
  const budget=(await query('select tokens::text from alchemy_rpc_budget where singleton')).rows[0];
  assert.ok(Number(budget.tokens)<2);
});

test('administrator settings expose only the deposit pause switch and reject retired configuration',async()=>{
  await query('update alchemy_rpc_state set deposits_paused=false');
  assert.equal((await app.inject({url:'/api/admin/settings'})).statusCode,401);
  const cookie=await operator(false),headers={cookie};
  const patch=(payload:Record<string,unknown>)=>app.inject({method:'PATCH',url:'/api/admin/settings',headers,payload});
  const settings=await app.inject({url:'/api/admin/settings',headers});assert.equal(settings.statusCode,200,settings.body);
  assert.deepEqual(settings.json(),{settings:[{key:'deposits_paused',value:false}],deposits_paused:false,provider_paused:false,issuance_paused:false});
  const overview=await app.inject({url:'/api/admin/overview',headers});assert.equal(overview.statusCode,200,overview.body);
  for(const field of ['deposit_provider','oxapay_ready','merchant_configured','public_origin'])assert.equal(Object.hasOwn(overview.json(),field),false,field);
  for(const payload of [{key:'deposit_provider',value:'direct'},{key:'deposit_provider',value:'oxapay'},
    {key:'oxapay_ready',value:true},{key:'merchant_configured',value:true},{key:'deposits_paused',value:'true'},
    {key:'deposits_paused',value:true,provider:'direct'},{deposits_paused:true},{}])
    assert.equal((await patch(payload)).statusCode,400,JSON.stringify(payload));
  for(const value of [true,false]){
    const saved=await patch({key:'deposits_paused',value});assert.equal(saved.statusCode,200,saved.body);
    assert.equal((await get(cookie)).json().deposits_paused,value);
    assert.equal((await app.inject({url:'/api/assets'})).json().deposits_paused,value);
  }
  assert.deepEqual((await query("select detail from audit_log where action='setting.update' order by id")).rows,
    [{detail:{key:'deposits_paused',value:true}},{detail:{key:'deposits_paused',value:false}}]);
  const secret=await app.inject({method:'PUT',url:'/api/admin/secrets',headers,payload:{name:'oxapay:merchant',value:'retired-fixture-only'}});
  assert.equal(secret.statusCode,400);
  const legacyRpc=await app.inject({method:'PUT',url:'/api/admin/secrets',headers,payload:{name:'rpc:ETH',value:'https://rpc.invalid'}});
  assert.equal(legacyRpc.statusCode,409);
  assert.equal((await query("select 1 from settings where key='deposit_provider'")).rowCount,0);
  assert.equal((await query("select 1 from secrets where name='oxapay:merchant'")).rowCount,0);
});

test('enrollment requires a fresh authenticator code and never returns or audits the envelope',async()=>{
  const who=await operator(),seed=randomBytes(32);
  const sealed=publicEncrypt({key:createPublicKey({key:Buffer.from(spki,'base64'),format:'der',type:'spki'}),
    padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from(keyId)},seed).toString('base64');seed.fill(0);
  const send=(body:Record<string,unknown>)=>app.inject({method:'POST',url:path+'/root',headers:{cookie:who},payload:body});
  assert.equal((await send({key_id:keyId,sealed_base64:'bad',totp:code(-1)})).statusCode,400);
  const body={key_id:keyId,sealed_base64:sealed,totp:code(-1)};
  const saved=await send(body);assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await send(body)).statusCode,403);
  assert.equal((await send({...body,totp:code()})).statusCode,409);
  const signer=await provisionCustodyKeys();assert.ok(signer);signer.destroy();
  const d=(await get(who)).json();assert.equal(d.key.configured,true);assert.equal(d.key.ready,true);
  const configuredAfterEnrollment=await putAlchemy(who,{api_key:alchemyKey,totp:code(1)});assert.equal(configuredAfterEnrollment.statusCode,200,configuredAfterEnrollment.body);
  assert.equal(await getSecret('alchemy:API_KEY'),alchemyKey);
  const removeOperator=await operator();
  assert.equal((await putAlchemy(removeOperator,{api_key:null,totp:code()})).statusCode,200);
  assert.ok(!JSON.stringify(d).includes(sealed));
  assert.deepEqual((await query("select detail from audit_log where action='custody.enroll'")).rows,[{detail:{key_id:keyId}}]);
});

test('network configuration pins destinations, waits for a checkpoint, prevents replay and pauses with a stale worker',async()=>{
  await setSecret('rpc:ETH',rpc,'fixture');
  const who=await operator(),status=(await get(who)).json();
  assert.equal((await put(who,{rpc_url:rpc,totp:code(-1)})).statusCode,400);
  assert.equal((await put(who,{destination:status.key.fee_address,totp:code(-1)})).statusCode,409);
  const saved=await put(who,{destination,totp:code(-1)});assert.equal(saved.statusCode,200,saved.body);
  assert.equal(await getSecret('rpc:ETH'),rpc);
  const pending=(await get(who)).json().networks.find((n:any)=>n.id==='ETH');
  assert.equal(pending.destination,destination);assert.equal(pending.destination_locked,true);assert.equal(pending.rpc_configured,true);assert.equal(pending.ready,false);
  assert.equal((await put(who,{enabled:true,destination,totp:code(-1)})).statusCode,403);
  assert.equal((await put(who,{enabled:true,destination,totp:code()})).statusCode,409);
  await query("insert into scanned_blocks(chain_id,height,hash) values('ETH',500,'fixture-checkpoint')");
  await query("update chains set last_scanned=500,scan_ready_at=clock_timestamp() where id='ETH'");
  const active=await put(who,{enabled:true,destination,totp:code()});assert.equal(active.statusCode,200,active.body);
  assert.equal((await putAlchemy(who,{api_key:alchemyKey,totp:code(1)})).statusCode,409);
  assert.equal((await put(who,{destination:'0x'+'c3'.repeat(20),totp:code(1)})).statusCode,409);
  await query('update custody_root set verified_at=null');
  const paused=await put(who,{enabled:false,totp:code(1)});assert.equal(paused.statusCode,200,paused.body);
  const response=await get(who),n=response.json().networks.find((n:any)=>n.id==='ETH');
  assert.equal(n.sweeps_enabled,false);assert.equal(n.ready,false);
  assert.ok(!response.body.includes(rpc));
  assert.ok(!(await query("select detail::text from audit_log where action='custody.network'")).rows.some(r=>r.detail.includes('private-credential')));
});

test('collection destinations cannot rotate, accept a token contract, or bypass the shared administrator throttle',async()=>{
  const who=await operator();
  assert.equal((await put(who,{destination:'0x'+'a3'.repeat(20),totp:code(-1)})).statusCode,409);
  assert.equal((await put(who,{destination:'0xdac17f958d2ee523a2206206994597c13d831ec7',totp:code(-1)},'BSC')).statusCode,409);
  assert.equal((await put(who,{destination:'11111111111111111111111111111111',totp:code(-1)},'SOL')).statusCode,400);
  for(let n=0;n<12;n++)assert.equal((await put(who,{enabled:false,totp:'invalid'})).statusCode,400);
  const r=await put(who,{enabled:false,totp:code()});assert.equal(r.statusCode,429);assert.equal(r.headers['retry-after'],'300');
  assert.equal((await get(who)).statusCode,200);
});
