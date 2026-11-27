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
const {encryptBlob,getSecret}=await import('../vault.js');
const {signAdminToken}=await import('../authutil.js');
const {provisionCustodyKeys}=await import('../custody/keys.js');
const temp=await mkdtemp(join(tmpdir(),'custody-api-'));
process.env.CUSTODY_KEY_DIR=join(temp,'private');
const app=await buildServer(),path='/api/admin/custody';
const destination='0x'+'b2'.repeat(20),rpc='https://rpc.test.invalid/private-credential';
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
  for(const field of ['deposit_provider','oxapay_ready','merchant_configured','public_origin'])assert.equal(Object.hasOwn(d,field),false,field);
  assert.deepEqual(d.networks.map((n:any)=>n.id).sort(),['BSC','ETH','POL','SOL']);
  assert.deepEqual(d.networks.flatMap((n:any)=>n.assets.map((a:any)=>a.id)).sort(),['BNB','ETH','POL','SOL','USDT.BEP20','USDT.ERC20','USDT.POL']);
  assert.ok(d.networks.every((n:any)=>n.sweeps_enabled===false&&n.ready===false&&n.rpc_configured===false));
  assert.doesNotMatch(r.body,/sealed_seed|wrap_spki|totp_secret_enc|signed_bytes/);
  assert.equal((await put(await operator(false),{enabled:false,totp:code()})).statusCode,403);
});

test('administrator settings expose only the deposit pause switch and reject retired configuration',async()=>{
  assert.equal((await app.inject({url:'/api/admin/settings'})).statusCode,401);
  const cookie=await operator(false),headers={cookie};
  const patch=(payload:Record<string,unknown>)=>app.inject({method:'PATCH',url:'/api/admin/settings',headers,payload});
  const settings=await app.inject({url:'/api/admin/settings',headers});assert.equal(settings.statusCode,200,settings.body);
  assert.deepEqual(settings.json(),{settings:[{key:'deposits_paused',value:false}],deposits_paused:false});
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
  assert.ok(!JSON.stringify(d).includes(sealed));
  assert.deepEqual((await query("select detail from audit_log where action='custody.enroll'")).rows,[{detail:{key_id:keyId}}]);
});

test('network configuration pins destinations, waits for a checkpoint, prevents replay and pauses with a stale worker',async()=>{
  const who=await operator(),status=(await get(who)).json();
  for(const rpc_url of ['http://rpc.test.invalid','https://user:pass@rpc.test.invalid','https://rpc.test.invalid/#secret'])
    assert.equal((await put(who,{rpc_url,totp:code(-1)})).statusCode,400);
  assert.equal((await put(who,{destination:status.key.fee_address,totp:code(-1)})).statusCode,409);
  const saved=await put(who,{rpc_url:rpc,destination,totp:code(-1)});assert.equal(saved.statusCode,200,saved.body);
  assert.equal(await getSecret('rpc:ETH'),rpc);
  const pending=(await get(who)).json().networks.find((n:any)=>n.id==='ETH');
  assert.equal(pending.destination,destination);assert.equal(pending.destination_locked,true);assert.equal(pending.rpc_configured,true);assert.equal(pending.ready,false);
  assert.equal((await put(who,{enabled:true,destination,totp:code(-1)})).statusCode,403);
  assert.equal((await put(who,{enabled:true,destination,totp:code()})).statusCode,409);
  await query("insert into scanned_blocks(chain_id,height,hash) values('ETH',500,'fixture-checkpoint')");
  await query("update chains set last_scanned=500,scan_ready_at=clock_timestamp() where id='ETH'");
  const active=await put(who,{enabled:true,destination,totp:code()});assert.equal(active.statusCode,200,active.body);
  assert.equal((await put(who,{rpc_url:rpc,totp:code(1)})).statusCode,409);
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
