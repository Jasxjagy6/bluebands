import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { Transaction } from 'ethers';
import { provisionCustodyKeys, restoreCustodyPublic } from '../custody/keys.js';
import { buildSolSweepMessage } from '../custody/sol-sweep.js';
import type { SweepIntent } from '../custody/types.js';

const runner=new URL(process.env.DATABASE_URL??'');
if (process.env.NODE_ENV!=='test' || !['127.0.0.1','localhost','[::1]'].includes(runner.hostname))
  throw new Error('Disposable loopback test database required');
const admin=new pg.Pool({connectionString:runner.href});
const dbName='custody_keys_'+randomBytes(12).toString('hex');
const isolated=new URL(runner); isolated.pathname='/'+dbName;
// db.ts config is resolved only AFTER switching to the newly-created fixture DB.
process.env.DATABASE_URL=isolated.href;
const {query,pool,tx}=await import('../db.js');
const {registerUser,verifySession}=await import('../auth-user.js');
const {getOrCreateAddress,submitCustodyEnvelope}=await import('../derive.js');
const {setSecret}=await import('../vault.js');
const temp=await mkdtemp(join(tmpdir(),'custody-key-fixture-'));
const keyDir=join(temp,'worker'), path=join(keyDir,'worker-rsa.pk8');
process.env.CUSTODY_KEY_DIR=keyDir;
const seed=randomBytes(32), legacy=randomUUID(), oldEth='0x'+randomBytes(20).toString('hex');
const oldSol=base58.encode(ed25519.getPublicKey(randomBytes(32)));
const chains=['ETH','BSC','POL','SOL'];
let keyId='', spki:Buffer, pending='', cipher:Buffer, missingSolUser='';
const signup=()=>{const name='p'+randomBytes(6).toString('hex');return registerUser(name+'@test.invalid',name,randomUUID());};
const status=async()=>(await query('select * from custody_public_key')).rows[0];

before(async()=>{
  await admin.query('create database '+dbName+' template template0');
  const dir=new URL('../../sql/',import.meta.url);
  for (const f of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) {
    if (f==='016_direct_custody.sql') {
      await query(`insert into users(id,email,username,pass_hash) values($1,'legacy@example.invalid','legacy','unused')`,[legacy]);
      await query(`insert into deposit_addresses(chain_id,user_id,address,deriv_index) values('ETH',$1,$2,77)`,[legacy,oldEth]);
      await query('insert into sol_receive_pool(address,user_id) values($1,$2)',[oldSol,legacy]);
    }
    await query(await readFile(new URL(f,dir),'utf8'));
  }
  await query('update chains set enabled=true where id=any($1::text[])',[chains]);
  for (const id of chains) await setSecret('rpc:'+id,'http://127.0.0.1:1/unreachable','fixture');
  await query('update chains set last_scanned=33,scan_ready_at=clock_timestamp() where id=any($1::text[])',[chains]);
});
after(async()=>{
  seed.fill(0); await pool.end();
  try { await admin.query('drop database if exists '+dbName); }
  finally { await admin.end(); await rm(temp,{recursive:true,force:true}); }
});

test('previous rows survive migration; signup succeeds without custody, and a heartbeat alone cannot release an address',async()=>{
  assert.deepEqual((await query('select chain_id,address,custody_kind,custody_key_id from deposit_addresses order by chain_id')).rows,[
    {chain_id:'ETH',address:oldEth,custody_kind:'legacy',custody_key_id:null},
    {chain_id:'SOL',address:oldSol,custody_kind:'legacy',custody_key_id:null},
  ]);
  const {user,token}=await signup(); pending=user.id;
  assert.equal(await verifySession(token),pending);
  assert.equal((await query('select 1 from deposit_addresses where user_id=$1',[pending])).rowCount,0);
  await assert.rejects(getOrCreateAddress(legacy,'ETH'),/unavailable/);
  await query("insert into scanned_blocks values ('ETH',33,'local-checkpoint')");
  assert.equal((await getOrCreateAddress(legacy,'ETH')).address,oldEth);
  await assert.rejects(getOrCreateAddress(pending,'ETH'),/unavailable/);
  await assert.rejects(getOrCreateAddress(legacy,'BTC'),/unavailable/);
});

test('parallel workers publish exactly one safe SPKI; WebCrypto seals raw bytes with the key identifier',async()=>{
  assert.deepEqual(await Promise.all([provisionCustodyKeys(),provisionCustodyKeys()]),[null,null]);
  const meta=await status(); keyId=meta.key_id; spki=Buffer.from(meta.spki,'base64');
  assert.match(keyId,/^[0-9a-f]{64}$/); assert.equal(createHash('sha256').update(spki).digest('hex'),keyId);
  assert.equal(meta.configured,false); assert.equal(meta.ready,false); assert.equal(meta.spki,spki.toString('base64'));
  assert.deepEqual(Object.keys(meta).sort(),['configured','evm_xpub','fee_address','key_id','ready','spki']);
  assert.equal((await stat(path)).mode&0o777,0o400); assert.equal((await stat(keyDir)).mode&0o777,0o700);
  const wrap=await webcrypto.subtle.importKey('spki',spki,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  cipher=Buffer.from(await webcrypto.subtle.encrypt({name:'RSA-OAEP',label:Buffer.from(keyId)},wrap,seed));
  for (const bad of [seed.toString('hex'),seed.toString('base64'),cipher.toString('base64')+'\n', 'x'.repeat(511)])
    await assert.rejects(tx(c=>submitCustodyEnvelope(c,keyId,bad)),/Invalid custody envelope/);
  await assert.rejects(tx(c=>submitCustodyEnvelope(c,'0'.repeat(64),cipher.toString('base64'))),/unavailable/);
  const savedKey=join(temp,'unenrolled-backup'); await rename(path,savedKey);
  await assert.rejects(provisionCustodyKeys(),/unavailable/);
  assert.equal((await status()).spki,null); assert.equal((await status()).key_id,keyId);
  await assert.rejects(tx(c=>submitCustodyEnvelope(c,keyId,cipher.toString('base64'))),/unavailable/);
  await rename(savedKey,path); assert.equal(await provisionCustodyKeys(),null);
  const both=await Promise.allSettled([0,1].map(()=>tx(c=>submitCustodyEnvelope(c,keyId,cipher.toString('base64')))));
  assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
  assert.deepEqual((await query('select sealed_seed from custody_root')).rows[0].sealed_seed,cipher);
  assert.equal((await status()).configured,true); assert.equal((await status()).ready,false);
  await assert.rejects(getOrCreateAddress(pending,'ETH'),/unavailable/);
  await assert.rejects(query('update custody_root set sealed_seed=null'),/permanent/);
  await assert.rejects(query('delete from custody_root'),/permanent/);
});

test('worker verifies the seal, publishes the same offline wallet, and signs only bound native/token/fee instructions',async()=>{
  const signer=await provisionCustodyKeys(); assert.ok(signer);
  try {
    const b=restoreCustodyPublic(seed,7), meta=await status();
    assert.equal(meta.ready,true); assert.equal(meta.evm_xpub,b.evmXpub); assert.equal(meta.fee_address,b.feeAddress);
    assert.equal((await query('select count(*) from custody_sol_pool where user_id is null')).rows[0].count,'32');
    const intent:SweepIntent={chainId:'ETH',jobId:'1',depositId:'2',keyId,assetId:'ETH',source:b.evmAddress,
      destination:'0x'+randomBytes(20).toString('hex'),derivIndex:7,sponsor:b.feeAddress,amount:1000000n,depositBlock:200,
      depositBlockHash:'0x'+randomBytes(32).toString('hex'),depositTxid:'0x'+randomBytes(32).toString('hex'),depositIndex:-1,requiredConf:15};
    const fields={phase:'sweep' as const,amount:979000n,gasPrice:1n,gasLimit:21000n,nonce:0};
    const decoded=Transaction.from(await signer.signEvmSweep(intent,fields));
    assert.equal(decoded.from!.toLowerCase(),b.evmAddress); assert.equal(decoded.to!.toLowerCase(),intent.destination);
    assert.equal(decoded.chainId,1n); assert.equal(decoded.value,fields.amount); assert.equal(decoded.data,'0x');
    const token={...intent,assetId:'USDT.ERC20',depositIndex:0};
    const sponsor=Transaction.from(await signer.signEvmSweep(token,{...fields,phase:'sponsor',amount:60000n}));
    assert.equal(sponsor.from!.toLowerCase(),b.feeAddress); assert.equal(sponsor.to!.toLowerCase(),b.evmAddress);
    const tokenTx=Transaction.from(await signer.signEvmSweep(token,{...fields,gasLimit:60000n,amount:token.amount}));
    assert.equal(tokenTx.from!.toLowerCase(),b.evmAddress); assert.equal(tokenTx.to!.toLowerCase(),'0xdac17f958d2ee523a2206206994597c13d831ec7');
    assert.equal(tokenTx.value,0n); assert.match(tokenTx.data,/^0xa9059cbb/);
    await assert.rejects(signer.signEvmSweep({...intent,keyId:'other'},fields));
    await assert.rejects(signer.signEvmSweep({...intent,source:b.feeAddress},fields));
    await assert.rejects(signer.signEvmSweep({...intent,destination:b.feeAddress},fields));
    await assert.rejects(signer.signEvmSweep(token,{...fields,phase:'sponsor',amount:10n**18n}));
    await assert.rejects(signer.signEvmSweep(intent,{...fields,phase:'sponsor'}));
    const s:SweepIntent={...intent,chainId:'SOL',assetId:'SOL',source:b.solAddress,destination:signer.solAddress(9),
      sponsor:null,depositIndex:0,depositBlockHash:base58.encode(randomBytes(32)),depositTxid:base58.encode(randomBytes(64))};
    const sf={amount:995000n,fee:5000n,blockhash:base58.encode(randomBytes(32))};
    const sig=await signer.signSolSweep(s,sf);
    assert.equal(ed25519.verify(sig,buildSolSweepMessage(s,sf),base58.decode(b.solAddress)),true);
    await assert.rejects(signer.signSolSweep({...s,derivIndex:8},sf));
    await assert.rejects(signer.signSolSweep({...s,assetId:'USDT.SPL'},sf));
    await assert.rejects(signer.signSolSweep(s,{...sf,fee:50001n}));
  } finally { signer.destroy(); }
  assert.throws(()=>signer.evmAddress(0)); assert.throws(()=>signer.solAddress(0));
});

test('committed startup checkpoint precedes new issuance; old accounts backfill lazily, legacy owners never change',async()=>{
  await assert.rejects(getOrCreateAddress(pending,'SOL'),/unavailable/);
  const db=await pool.connect();
  try {
    await db.query('begin'); await db.query("select id from chains where id='BSC' for update");
    await db.query("insert into scanned_blocks values ('BSC',33,'local-checkpoint')");
    const unavailable=assert.rejects(getOrCreateAddress(pending,'BSC'),/unavailable/);
    await db.query('rollback'); await unavailable;
  } finally { db.release(); }
  await query("insert into scanned_blocks values ('BSC',33,'b'),('POL',33,'p'),('SOL',32,'previous-finalized-slot')");
  const parallel=await Promise.all(Array.from({length:18},(_,i)=>getOrCreateAddress(pending,chains[i%3]!)));
  assert.equal(new Set(parallel.map(r=>r.address)).size,1);
  assert.equal((await query('select count(*) from custody_evm_users where user_id=$1',[pending])).rows[0].count,'1');
  assert.equal((await getOrCreateAddress(legacy,'SOL')).address,oldSol); assert.equal((await getOrCreateAddress(legacy,'ETH')).address,oldEth);
  assert.notEqual((await getOrCreateAddress(legacy,'BSC')).address,oldEth);
  await assert.rejects(query("update deposit_addresses set custody_kind='managed',custody_key_id=$2 where user_id=$1 and chain_id='ETH'",[legacy,keyId]),/permanent/);
  await assert.rejects(query('update sol_receive_pool set user_id=null where address=$1',[oldSol]),/permanent/);
  await assert.rejects(query("insert into deposit_addresses(user_id,chain_id,address,deriv_index) values($1,'TRON','fake',0)",[pending]),/Legacy issuance is closed/);
  await query("update settings set value='true' where key='deposits_paused'");
  await assert.rejects(getOrCreateAddress(pending,'ETH'),/unavailable/);
  const paused=await signup(); assert.equal((await query('select 1 from deposit_addresses where user_id=$1',[paused.user.id])).rowCount,0);
  await query("update settings set value='false' where key='deposits_paused'");
});

test('simultaneous signups get unique permanent paths; SOL exhaustion defers only that chain and refills deterministically',async()=>{
  const signups=await Promise.all(Array.from({length:34},signup));
  const ids=signups.map(r=>r.user.id);
  const evm=(await query(`select user_id,count(*)::int as chains,count(distinct address)::int as addresses,count(distinct deriv_index)::int as paths
    from deposit_addresses where user_id=any($1::uuid[]) and chain_id in ('ETH','BSC','POL') group by user_id`,[ids])).rows;
  assert.equal(evm.length,34); assert.ok(evm.every(r=>r.chains===3 && r.addresses===1 && r.paths===1));
  const sol=(await query('select user_id,deriv_index,address from custody_sol_pool where user_id is not null')).rows;
  assert.equal(sol.length,32); assert.equal(new Set(sol.map(r=>r.deriv_index)).size,32);
  assert.equal(new Set(sol.map(r=>r.address)).size,32); assert.equal(new Set(sol.map(r=>r.user_id)).size,32);
  assert.equal((await getOrCreateAddress(sol[0].user_id,'SOL')).address,sol[0].address);
  missingSolUser=ids.find(id=>!sol.some(r=>r.user_id===id))!;
  assert.ok(missingSolUser); await assert.rejects(getOrCreateAddress(missingSolUser,'SOL'),/unavailable/);
  const leases=await Promise.all([provisionCustodyKeys(),provisionCustodyKeys()]);
  for (const lease of leases) lease!.destroy();
  const replies=await Promise.all(Array.from({length:12},()=>getOrCreateAddress(missingSolUser,'SOL')));
  assert.equal(new Set(replies.map(r=>r.address)).size,1);
  assert.equal((await query('select count(*) from custody_sol_pool')).rows[0].count,'64');
  const saved=(await query('select deriv_index,address from custody_sol_pool where user_id=$1',[missingSolUser])).rows[0];
  assert.equal(saved.deriv_index,32); assert.equal(saved.address,restoreCustodyPublic(seed,32).solAddress);
  const survivor=await Promise.allSettled([0,1].map(()=>registerUser('one@fixture.invalid','one_only',randomUUID())));
  assert.equal(survivor.filter(r=>r.status==='fulfilled').length,1);
});

test('wrong directory mode, wrong file mode, symlink, missing file and a lost volume all retain the pinned wallet',async()=>{
  const id=(await status()).key_id, original=(await getOrCreateAddress(missingSolUser,'SOL')).address;
  const backup=join(temp,'fixture-backup.pk8');
  await chmod(path,0o644); await assert.rejects(provisionCustodyKeys(),/unavailable/);
  assert.equal((await status()).ready,false); await assert.rejects(getOrCreateAddress(missingSolUser,'SOL'),/unavailable/);
  await chmod(path,0o600); await chmod(keyDir,0o755); await assert.rejects(provisionCustodyKeys(),/unavailable/); await chmod(keyDir,0o700);
  await rename(path,backup); await symlink(backup,path); await assert.rejects(provisionCustodyKeys(),/unavailable/); await rm(path);
  await assert.rejects(provisionCustodyKeys(),/unavailable/); assert.deepEqual(await readdir(keyDir),[]);
  process.env.CUSTODY_KEY_DIR=join(temp,'missing-volume');
  try { await assert.rejects(provisionCustodyKeys(),/unavailable/); await assert.rejects(stat(process.env.CUSTODY_KEY_DIR!),{code:'ENOENT'}); }
  finally { process.env.CUSTODY_KEY_DIR=keyDir; }
  const foreign=await mkdtemp(join(temp,'other-worker-'));
  // Publish a different fixture worker identity into an isolated empty schema, then
  // mount its private directory against the real fixture DB. It must not rotate.
  await query('create schema foreign_worker');
  await query('create table foreign_worker.custody_root (like public.custody_root including all)');
  await useSchema('foreign_worker'); process.env.CUSTODY_KEY_DIR=foreign;
  try { assert.equal(await provisionCustodyKeys(),null); } finally { await useSchema('public'); }
  try { await assert.rejects(provisionCustodyKeys(),/unavailable/); } finally { process.env.CUSTODY_KEY_DIR=keyDir; }
  assert.equal((await status()).key_id,id); assert.equal((await status()).configured,true);
  await assert.rejects(tx(c=>submitCustodyEnvelope(c,keyId,cipher.toString('base64'))),/already configured/);
  await rename(backup,path); (await provisionCustodyKeys())!.destroy();
  assert.equal((await getOrCreateAddress(missingSolUser,'SOL')).address,original);
  await query("update custody_root set verified_at=clock_timestamp()-interval '3 minutes'");
  assert.equal((await status()).ready,false); await assert.rejects(getOrCreateAddress(missingSolUser,'SOL'),/unavailable/);
  assert.equal((await getOrCreateAddress(legacy,'ETH')).address,oldEth);
});

async function useSchema(schema:string) {
  assert.match(schema,/^[a-z0-9_]+$/);
  await query(`alter database ${dbName} set search_path to ${schema}, public`);
  const clients=await Promise.all(Array.from({length:10},()=>pool.connect()));
  try { await Promise.all(clients.map(c=>c.query(`set search_path to ${schema}, public`))); }
  finally { for (const c of clients)c.release(); }
}

test('bad OAEP label, ASCII hex payload, and vault KEK cannot become a verified wallet or be overwritten',async()=>{
  const pub=createPublicKey({key:spki,format:'der',type:'spki'});
  for (const [label,plaintext] of [[Buffer.from('wrong label'),seed],[Buffer.from(keyId),Buffer.from(seed.toString('hex'))],
    [Buffer.from(keyId),Buffer.from(process.env.TREASURY_MASTER_KEY!,'base64')]] as const) {
    // Rebuild the disposable custody fixture using a new, isolated schema. The
    // production path has NO reset; redirect all connections of the test role.
    const schema='bad_envelope_'+randomBytes(8).toString('hex');
    await query('create schema '+schema);
    await query(`create table ${schema}.custody_root (like public.custody_root including all)`);
    await useSchema(schema);
    assert.equal(await provisionCustodyKeys(),null);
    const sealed=publicEncrypt({key:pub,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:label},plaintext);
    await tx(c=>submitCustodyEnvelope(c,keyId,sealed.toString('base64')));
    await assert.rejects(provisionCustodyKeys(),/unavailable/);
    assert.deepEqual((await query('select sealed_seed is not null as configured,evm_xpub,verified_at from custody_root')).rows[0],
      {configured:true,evm_xpub:null,verified_at:null});
    await assert.rejects(tx(c=>submitCustodyEnvelope(c,keyId,sealed.toString('base64'))),/already configured/);
  }
});
