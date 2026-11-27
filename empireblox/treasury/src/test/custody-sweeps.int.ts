import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak256 } from 'ethers';
import { creditConfirmedDeposit, post } from '../ledger.js';
import { SweepEngine } from '../custody/sweep-engine.js';
import { SweepStop, type SignedSweep, type SweepAdapter, type SweepChain, type SweepIntent,
  type SweepObservation, type SweepReason } from '../custody/types.js';

// Only use the runner's disposable local server. Each test gets a private copy of
// an empty, fully migrated template database, never any existing application data.
const url = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV !== 'test' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
  throw new Error('A disposable loopback test database is required');
const admin = new pg.Pool({ connectionString: url.href }), prefix = 'sweep_fixture_' + randomBytes(8).toString('hex');
const dbUrl = (name: string) => { const u = new URL(url); u.pathname = '/' + name; return u.href; };
const sha = (v: string) => createHash('sha256').update(v).digest();
const address = (v: string) => '0x' + sha(v).subarray(12).toString('hex');
const sol = (v: string) => base58.encode(ed25519.getPublicKey(sha(v)));
const cold = address('cold'), gas = address('gas'), keyId = sha('fixture public metadata only').toString('hex');
const legacy = { user: randomUUID(), source: address('legacy') };
const archived = { invoice: randomUUID(), txid: '0x'+sha('archived payment').toString('hex'), amount: 10n**18n };
let db: pg.Pool, engine: SweepEngine, remote: FixtureAdapter, dbName = '', sequence = 0;

before(async () => {
  await admin.query('create database ' + prefix + ' template template0');
  const template = new pg.Pool({ connectionString: dbUrl(prefix), max: 1 });
  const sql = new URL('../../sql/', import.meta.url);
  try {
    for (const file of (await readdir(sql)).filter(n => n.endsWith('.sql')).sort()) {
      if(file==='019_direct_deposits_only.sql'){
        const c=await template.connect();
        try{
          await c.query('begin');
          await c.query('insert into users(id,email,username,pass_hash) values ($1,$2,$3,$4)', [legacy.user,'legacy@test.invalid','legacy','fixture']);
          const journal=await post(c,'deposit','oxapay:'+archived.invoice,[{account:'u:'+legacy.user,asset:'ETH',delta:archived.amount},
            {account:'ext:archived',asset:'ETH',delta:-archived.amount}]);
          await c.query(`insert into oxapay_invoices(id,user_id,request,asset_id,symbol,decimals,amount,public_origin,networks,
            dispatched_at,track_id,status,journal_id,credited_at) values($1,$2,$3,'ETH','ETH',18,$4,'https://retired.test.invalid',
            array['ETH'],now(),$6,'credited',$5,now())`,[archived.invoice,legacy.user,randomUUID(),archived.amount.toString(),journal,archived.invoice]);
          await c.query(`insert into oxapay_transfers(invoice_id,chain_id,txid,amount,address) values($1,'ETH',$2,$3,$4)`,
            [archived.invoice,archived.txid,archived.amount.toString(),legacy.source]);
          await c.query(`insert into audit_log(actor,action,detail) values('fixture','archived.payment',$1)`,[{invoice:archived.invoice}]);
          await c.query('commit');
        }catch(e){await c.query('rollback');throw e;}finally{c.release();}
      }
      await template.query(await readFile(new URL(file, sql), 'utf8'));
    }
    await template.query(`insert into deposit_addresses(user_id,chain_id,address,deriv_index) values($1,'ETH',$2,99)`, [legacy.user,legacy.source]);
    // Inert public metadata. No wrapping key, decryptable seed, credentials or real signed wire is used.
    await template.query(`insert into custody_root(key_id,wrap_spki,sealed_seed,evm_xpub,fee_address,verified_at)
      values($1,$2,$3,$4,$5,now())`, [keyId, Buffer.from('fixture public metadata only'), Buffer.alloc(384), 'xpub' + '1'.repeat(107), gas]);
    await template.query(`update chains set enabled=true where id in ('ETH','BSC','POL','SOL')`);
    await template.query(`update custody_sweep_networks set destination=case when chain_id='SOL' then $1 else $2 end`, [sol('cold'),cold]);
    await template.query(`update custody_sweep_networks set sweeps_enabled=true`);
  } finally { await template.end(); }
});
beforeEach(async () => {
  dbName = prefix + '_' + ++sequence;
  await admin.query(`create database ${dbName} template ${prefix}`);
  db = new pg.Pool({ connectionString: dbUrl(dbName), max: 16 });
  await db.query('update custody_root set verified_at=clock_timestamp()');
  engine = new SweepEngine(db, 0); remote = new FixtureAdapter();
});
afterEach(async () => { if (db) await db.end(); if (dbName) await admin.query('drop database if exists ' + dbName); });
after(async () => { try { await admin.query('drop database if exists ' + prefix); } finally { await admin.end(); } });

async function owner(chain: SweepChain) {
  const user = randomUUID(), index = ++sequence, source = chain === 'SOL' ? sol(user) : address(user);
  await db.query('insert into users(id,email,username,pass_hash) values($1,$2,$3,$4)', [user, user+'@test.invalid', 'u'+index, 'fixture']);
  await db.query(`insert into ${chain === 'SOL' ? 'custody_sol_pool' : 'custody_evm_users'}(key_id,deriv_index,address,user_id) values($1,$2,$3,$4)`, [keyId,index,source,user]);
  await db.query(`insert into deposit_addresses(chain_id,custody_kind,custody_key_id,deriv_index,address,user_id) values($1,'managed',$2,$3,$4,$5)`, [chain,keyId,index,source,user]);
  return { user, source };
}
async function deposit(chain: SweepChain, asset: string, o: { user: string; source: string }, opts: { amount?: bigint; status?: string; txid?: string } = {}) {
  const status = opts.status ?? 'credited', amount = (opts.amount ?? 10n**19n).toString();
  const c = await db.connect();
  try {
    await c.query('begin');
    const row = (await c.query(`insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,
      confirmations,required_conf,status,confirmed_at) values($1,$2,$3,$4,$5,$6,$7,100,$9,20,15,$8,now()) returning id`,
    [chain,asset,o.user,o.source,opts.txid ?? (chain==='SOL'?base58.encode(randomBytes(64)):'0x'+sha(randomUUID()).toString('hex')),
      chain==='SOL' || asset.startsWith('USDT') ? 0 : -1, amount,status === 'credited' ? 'confirmed' : status,
      chain==='SOL'?base58.encode(sha('fixture-block')):'0x'+sha('fixture-block').toString('hex')])).rows[0];
    if (row && status === 'credited') assert.equal(await creditConfirmedDeposit(c,row.id),true);
    await c.query('commit'); return row?.id as string | undefined;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const job = async (depositId: string | undefined) => (await db.query('select * from custody_sweep_status where deposit_id=$1',[depositId])).rows[0];
const once = (chain: SweepChain = 'ETH') => engine.advance(chain,remote);
async function until(predicate: () => boolean | Promise<boolean>, chain: SweepChain = 'ETH') {
  for (let n=0; n<40; n++) { if (await predicate()) return; await once(chain); }
  assert.fail('Fixture did not reach expected durable state');
}
async function forbidLedgerWrites() {
  await db.query(`create function deny_ledger_write() returns trigger language plpgsql as $$ begin raise exception 'Sweep touched ledger'; end $$`);
  for (const t of ['ledger_entries','journals','balances'])
    await db.query(`create trigger fail_on_sweep_write before insert or update or delete on ${t} for each statement execute function deny_ledger_write()`);
}

class FixtureAdapter implements SweepAdapter {
  prepared: { deposit: string; step: SignedSweep }[] = [];
  sent: string[] = []; accepted = new Set<string>(); observations = new Map<string,SweepObservation>();
  nonce = new Map<string,number>(); checks = new Map<string,SweepReason>(); loseAck = false;
  async verifyDeposit(i: SweepIntent) { const reason=this.checks.get(i.depositId); if(reason) throw new SweepStop(reason); }
  async prepare(i: SweepIntent, sponsor: SignedSweep | null) {
    const phase = i.assetId.startsWith('USDT') && !sponsor ? 'sponsor' : 'sweep';
    const from = phase === 'sponsor' ? i.sponsor! : i.source, fee = 5_000n;
    const amount = phase === 'sponsor' ? 10_000n : i.assetId.startsWith('USDT') ? i.amount : i.amount-fee;
    const bytes = Buffer.from('not a real transaction:'+i.jobId+':'+phase+':'+this.prepared.length);
    const wire = Buffer.concat([Buffer.from([1]),sha(bytes.toString()),sha('sig'+bytes.toString()),bytes]);
    const s: SignedSweep = { phase, from, amount, fee, nonce: i.chainId==='SOL'?null:String(this.nonce.get(from)??0),
      raw:i.chainId==='SOL'?wire.toString('base64'):'0x'+bytes.toString('hex'),txid:i.chainId==='SOL'?base58.encode(wire.subarray(1,65)):keccak256(bytes),
      lastValidBlockHeight:i.chainId==='SOL'?1_000:null };
    this.prepared.push({deposit:i.depositId,step:s}); return s;
  }
  async inspect(_i:SweepIntent,s:SignedSweep):Promise<SweepObservation> { return this.observations.get(s.txid) ?? {state:'unseen'}; }
  async broadcast(i:SweepIntent,s:SignedSweep) {
    // NO transport. Prove that a different connection can already see this exact wire and claim hash.
    assert.deepEqual(await new SweepEngine(db).readCommittedStep(i.jobId,s.phase),s);
    this.sent.push(s.raw); this.accepted.add(s.txid);
    if(this.loseAck){this.loseAck=false;throw new Error('simulated response lost');}
  }
  final(s:SignedSweep) {
    this.observations.set(s.txid,{state:'final',blockNumber:115,blockHash:'final-block'});
    if(s.nonce!==null)this.nonce.set(s.from,Number(s.nonce)+1);
  }
}

test('retired hosted evidence stays readable and immutable without changing its settled journal, balance or audit',async()=>{
  const evidence=async()=>({
    invoice:(await db.query('select * from oxapay_invoices where id=$1',[archived.invoice])).rows,
    transfers:(await db.query('select * from oxapay_transfers where invoice_id=$1',[archived.invoice])).rows,
    journals:(await db.query('select * from journals where ref=$1',['oxapay:'+archived.invoice])).rows,
    entries:(await db.query('select * from ledger_entries where journal_id=(select id from journals where ref=$1) order by id',['oxapay:'+archived.invoice])).rows,
    balance:(await db.query("select amount::text from balances where account=$1 and asset_id='ETH'",['u:'+legacy.user])).rows,
    audit:(await db.query("select * from audit_log where action='archived.payment'")).rows,
  });
  const original=await evidence();assert.equal(original.invoice[0].next_check_at,null);
  assert.equal(original.journals.length,1);assert.equal(original.entries.length,2);assert.equal(original.audit.length,1);
  assert.deepEqual(original.balance,[{amount:archived.amount.toString()}]);
  const record=(await db.query('select provider,status,journal_id from deposit_records where id=$1',[archived.invoice])).rows[0];
  assert.deepEqual(record,{provider:'archived',status:'credited',journal_id:original.journals[0].id});
  await assert.rejects(db.query(`insert into oxapay_invoices(user_id,request,asset_id,symbol,decimals,amount,public_origin)
    values($1,$2,'ETH','ETH',18,1,'https://retired.test.invalid')`,[legacy.user,randomUUID()]),/Hosted checkout is retired/i);
  await assert.rejects(db.query(`insert into oxapay_transfers(invoice_id,chain_id,txid,amount,address) values($1,'ETH',$2,1,$3)`,
    [archived.invoice,'0x'+sha('new retired write').toString('hex'),legacy.source]),/Hosted checkout is retired/i);
  await assert.rejects(db.query("update oxapay_invoices set next_check_at=now() where id=$1",[archived.invoice]),/Hosted checkout is retired/i);
  await assert.rejects(db.query('delete from oxapay_invoices where id=$1',[archived.invoice]),/Hosted checkout is retired/i);
  await assert.rejects(db.query('update oxapay_transfers set amount=amount+1 where invoice_id=$1',[archived.invoice]),/Hosted checkout is retired/i);
  await assert.rejects(db.query('delete from oxapay_transfers where invoice_id=$1',[archived.invoice]),/Hosted checkout is retired/i);
  assert.deepEqual(await evidence(),original);
});

test('eligibility joins all seven exact routes to the managed assignment, credit journal, active key and minimum', async () => {
  const eth = await owner('ETH'), bsc = await owner('BSC'), pol = await owner('POL'), solana = await owner('SOL');
  const ids = await Promise.all([deposit('ETH','ETH',eth),deposit('ETH','USDT.ERC20',eth),deposit('BSC','BNB',bsc),
    deposit('BSC','USDT.BEP20',bsc),deposit('POL','POL',pol),deposit('POL','USDT.POL',pol),deposit('SOL','SOL',solana)]);
  await deposit('SOL','USDT.SPL',solana); await deposit('ETH','ETH',legacy);
  await deposit('ETH','ETH',{user:eth.user,source:address('no assignment')});
  await deposit('ETH','ETH',eth,{status:'pending'}); await deposit('ETH','ETH',eth,{status:'orphaned'});
  await deposit('ETH','USDT.ERC20',eth,{amount:999_999n});
  await deposit('ETH','ETH',eth,{txid:'not-a-chain-transaction'});
  await db.query(`update assets set min_deposit=0 where id='ETH'`); await deposit('ETH','ETH',eth,{amount:1000n});
  const bad = await deposit('ETH','ETH',eth); await db.query(`update journals set ref='unrelated' where id=(select journal_id from deposits where id=$1)`,[bad]);
  await db.query('update custody_root set verified_at=null'); assert.equal(await engine.enqueue('ETH'),0);
  await db.query('update custody_root set verified_at=now()');
  for(const chain of ['ETH','BSC','POL','SOL'] as const) await Promise.all([engine.enqueue(chain),new SweepEngine(db).enqueue(chain)]);
  assert.deepEqual((await db.query('select deposit_id from custody_sweep_jobs')).rows.map(r=>r.deposit_id).sort(),ids.sort());
  assert.equal(remote.prepared.length,0);
});

test('commit before send, crash before/after broadcast, lost acknowledgement, and same bytes after restart',async()=>{
  const dep = await deposit('ETH','ETH',await owner('ETH')); await forbidLedgerWrites();
  await engine.enqueue('ETH'); await once();
  const s=remote.prepared[0]!.step; assert.deepEqual(remote.sent,[]); assert.equal((await job(dep)).status,'sweep_signed');
  await assert.rejects(db.query(`update custody_sweep_steps set raw='broken'`),/immutable/i);
  await assert.rejects(db.query(`delete from custody_sweep_steps`),/immutable/i);
  await db.query(`create function lose_db_commit() returns trigger language plpgsql as $$ begin raise exception 'synthetic process crash'; end $$;
    create trigger lose_db_commit before update on custody_sweep_jobs for each row when (new.status='sweep_pending') execute function lose_db_commit()`);
  engine=new SweepEngine(db,0); await assert.rejects(once(),/synthetic process crash/);
  assert.equal((await job(dep)).status,'sweep_signed'); assert.deepEqual(remote.sent,[s.raw]);
  await db.query('drop trigger lose_db_commit on custody_sweep_jobs'); remote.loseAck=true;
  assert.equal(await once(),'unavailable'); await once();
  assert.deepEqual(remote.sent,[s.raw,s.raw,s.raw]); assert.equal(remote.accepted.size,1); assert.equal(remote.prepared.length,1);
  remote.observations.set(s.txid,{state:'included',blockHash:'final-block',blockNumber:115}); await once();
  assert.equal((await job(dep)).status,'sweep_pending'); remote.final(s); await once();
  assert.equal((await job(dep)).status,'completed'); await once(); assert.equal(await engine.enqueue('ETH'),0);
  assert.equal(Object.hasOwn(await job(dep),'raw'),false);
});

test('replicas serialize source and sponsorship, exclude the exact committed funding hash and never double-fund',async()=>{
  const a=await owner('ETH'),b=await owner('ETH');
  const one=await deposit('ETH','USDT.ERC20',a),two=await deposit('ETH','USDT.ERC20',b),native=await deposit('ETH','ETH',a);
  await engine.enqueue('ETH');
  const competitors=()=>Promise.all(Array.from({length:6},()=>new SweepEngine(db,0).advance('ETH',remote)));
  await competitors(); await competitors();
  const first=remote.prepared[0]!; assert.equal(first.step.phase,'sponsor'); assert.equal(remote.prepared.length,1);
  const funded=first.deposit===one?a:b;
  assert.equal(await deposit('ETH','ETH',funded,{txid:first.step.txid.toUpperCase(),status:'pending'}),undefined);
  // The internal-transfer fence still discards this claim before the retirement trigger.
  const claim=await db.query(`insert into oxapay_transfers(invoice_id,chain_id,txid,amount,address) values($1,'ETH',$2,1,$3)`,[archived.invoice,first.step.txid,funded.source]);
  assert.equal(claim.rowCount,0);
  assert.equal((await db.query('select 1 from oxapay_transfers where chain_id=$1 and txid=$2',['ETH',first.step.txid])).rowCount,0);
  assert.ok(await deposit('BSC','BNB',funded,{txid:first.step.txid,status:'pending'}),'same hash on a different chain is not an internal claim');
  await forbidLedgerWrites(); remote.final(first.step);
  await until(()=>remote.prepared.some(p=>p.deposit===first.deposit&&p.step.phase==='sweep'));
  const token=remote.prepared.find(p=>p.deposit===first.deposit&&p.step.phase==='sweep')!.step;
  if(first.deposit===one) assert.equal(remote.prepared.some(p=>p.deposit===native),false);
  assert.equal(token.amount,10n**19n); assert.ok(token.fee<=first.step.amount);
  await until(()=>remote.accepted.has(token.txid)); remote.final(token);
  await until(async()=>(await job(first.deposit)).status==='completed');
  await until(()=>remote.prepared.some(p=>p.deposit===(first.deposit===one?two:one)&&p.step.phase==='sponsor'));
  const sponsors=remote.prepared.filter(p=>p.step.phase==='sponsor');
  assert.equal(sponsors.length,2);assert.deepEqual(sponsors.map(p=>p.step.nonce),['0','1']);
  assert.equal((await db.query(`select count(*) from custody_sweep_steps where job_id=(select id from custody_sweep_jobs where deposit_id=$1) and phase='sponsor'`,[first.deposit])).rows[0].count,'1');
});

test('a wrong chain, orphaned input or changed token contract cannot trigger a signature or a treasury top-up',async()=>{
  const wrong=await deposit('ETH','ETH',await owner('ETH')),orphan=await deposit('ETH','ETH',await owner('ETH'));
  const drift=await deposit('ETH','USDT.ERC20',await owner('ETH')); await engine.enqueue('ETH');
  remote.checks.set(wrong!,'wrong_chain'); remote.checks.set(orphan!,'orphaned');
  await db.query(`update assets set token_address=$1 where id='USDT.ERC20'`,[address('imitator')]);
  for(let i=0;i<6;i++)await once();
  assert.deepEqual(await Promise.all([wrong,orphan,drift].map(async d=>(await job(d)).status)),['review','review','review']);
  assert.equal(remote.prepared.length,0);assert.equal(remote.sent.length,0);
});

test('pause stops sends but not receipt checks; pinned destinations cannot be changed, reused as receive or pointed at fee/user addresses',async()=>{
  const a=await owner('ETH'), dep=await deposit('ETH','ETH',a), newer=address('replacement');
  await engine.enqueue('ETH'); await once(); const s=remote.prepared[0]!.step;
  await assert.rejects(db.query(`update custody_sweep_jobs set destination=$1`,[newer]),/immutable/i);
  await db.query(`update custody_sweep_networks set sweeps_enabled=false where chain_id='ETH'`);
  await assert.rejects(db.query(`update custody_sweep_networks set destination=$1 where chain_id='ETH'`,[newer]),/pinned/i);
  await once(); assert.equal(remote.sent.length,0); remote.final(s); await once(); assert.equal((await job(dep)).status,'completed');
  for(const blocked of [a.source,gas])await assert.rejects(db.query(`update custody_sweep_networks set destination=$1 where chain_id='ETH'`,[blocked]),/role conflict/i);
  await db.query(`update custody_sweep_networks set destination=$1 where chain_id='ETH'`,[newer]);
  assert.equal((await db.query('select destination from custody_sweep_jobs')).rows[0].destination,cold);
  const other=await owner('SOL');
  await assert.rejects(db.query(`insert into custody_evm_users(user_id,key_id,address,deriv_index) values($1,$2,$3,999)`,[other.user,keyId,cold]),/role conflict/i);
});

test('canonical sponsor is rechecked before token send; lost finality quarantines job without a replacement',async()=>{
  const dep=await deposit('ETH','USDT.ERC20',await owner('ETH')); await engine.enqueue('ETH');await once();await once();
  const sponsor=remote.prepared[0]!.step; remote.final(sponsor);await once();await once();
  assert.equal((await job(dep)).status,'sweep_signed'); remote.observations.set(sponsor.txid,{state:'unseen'});
  await once(); await once(); assert.equal((await job(dep)).status,'review'); assert.equal((await job(dep)).last_error,'orphaned');
  assert.deepEqual(remote.sent,[sponsor.raw]);assert.equal(remote.prepared.length,2);
});

test('Solana blockhash expiry, failed receipts and disappearing included blocks never authorize replacement or completion',async()=>{
  const expired=await deposit('SOL','SOL',await owner('SOL')),failed=await deposit('SOL','SOL',await owner('SOL')),reorg=await deposit('SOL','SOL',await owner('SOL'));
  await engine.enqueue('SOL');await until(()=>remote.prepared.length===3,'SOL');
  for(const p of remote.prepared) remote.observations.set(p.step.txid,p.deposit===expired?{state:'review',reason:'expired'}:
    p.deposit===failed?{state:'review',reason:'invalid_receipt'}:{state:'included',blockHash:'old-slot',blockNumber:12});
  await until(async()=>Boolean((await db.query(`select 1 from custody_sweep_steps where block_hash='old-slot'`)).rowCount),'SOL');
  remote.observations.set(remote.prepared.find(p=>p.deposit===reorg)!.step.txid,{state:'pending'});
  await until(async()=>(await db.query(`select count(*) from custody_sweep_jobs where status='review'`)).rows[0].count==='3','SOL');
  assert.equal(remote.prepared.length,3);assert.equal((await job(reorg)).last_error,'orphaned');
});

test('commissioned depth is pinned, a stale key cannot dispatch, and an unaccounted EVM nonce goes to review',async()=>{
  const a=await owner('BSC'), dep=await deposit('BSC','BNB',a);
  await db.query(`update chains set required_conf=64 where id='BSC'`); await engine.enqueue('BSC');
  await db.query(`update chains set required_conf=1 where id='BSC'`);
  const depths:number[]=[]; remote.verifyDeposit=async i=>{depths.push(i.requiredConf);};
  await once('BSC'); assert.equal(depths[0],64); assert.equal((await job(dep)).status,'sweep_signed');
  await db.query('update custody_root set verified_at=null');await once('BSC');assert.deepEqual(remote.sent,[]);
  await db.query('update custody_root set verified_at=now()');await db.query(`update chains set required_conf=128 where id='BSC'`);
  await once('BSC');assert.equal(depths.at(-1),128);assert.equal(remote.sent.length,1);
  const solana=await deposit('SOL','SOL',await owner('SOL'));await engine.enqueue('SOL');await once('SOL');await once('SOL');
  remote.final(remote.prepared.find(p=>p.deposit===solana)!.step);await once('SOL');assert.equal((await job(solana)).status,'completed');
  const pol=await owner('POL');remote.nonce.set(pol.source,5);const gap=await deposit('POL','POL',pol);await engine.enqueue('POL');await once('POL');
  assert.equal((await job(gap)).last_error,'nonce_conflict');assert.equal((await job(gap)).txid,null);
});

test('sponsor spending is bounded per signed transfer and in aggregate even across distinct credited jobs',async()=>{
  const cap=600_000_000_000_000n;let oversized=true;
  const prepare=remote.prepare.bind(remote);remote.prepare=async(i,prior)=>{
    const s=await prepare(i,prior);if(s.phase==='sponsor')s.amount=cap-s.fee+(oversized?1n:0n);return s;
  };
  for(let n=0;n<11;n++)await deposit('BSC','USDT.BEP20',await owner('BSC'));
  await engine.enqueue('BSC');assert.equal(await once('BSC'),'fee_limit');assert.equal((await db.query('select 1 from custody_sweep_steps')).rowCount,0);
  oversized=false;await forbidLedgerWrites();
  for(let n=0;n<170;n++){
    await once('BSC');
    for(const {step} of remote.prepared)if(remote.accepted.has(step.txid))remote.final(step);
    if((await db.query(`select 1 from custody_sweep_jobs where status='completed'`)).rowCount===10)break;
  }
  await once('BSC');const states=(await db.query('select status,last_error from custody_sweep_jobs')).rows;
  assert.equal(states.filter(r=>r.status==='completed').length,10);assert.deepEqual(states.filter(r=>r.status!=='completed'),[{status:'queued',last_error:'fee_limit'}]);
  assert.equal((await db.query(`select sum(amount+fee) as total from custody_sweep_steps where phase='sponsor'`)).rows[0].total,String(10n*cap));
});
