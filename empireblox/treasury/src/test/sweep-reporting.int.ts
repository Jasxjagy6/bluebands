import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';

const runner=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(runner.hostname))throw Error('Disposable local database required');
const control=new pg.Pool({connectionString:runner.href}),name='sweep_report_'+randomBytes(8).toString('hex');
const isolated=new URL(runner);isolated.pathname='/'+name;process.env.DATABASE_URL=isolated.href;
const {query,pool,tx}=await import('../db.js');
const {buildServer}=await import('../api/server.js');
const {signAdminToken}=await import('../authutil.js');
const {createSession}=await import('../auth-user.js');
const {creditConfirmedDeposit}=await import('../ledger.js');
const {setSecret}=await import('../vault.js');
const {SweepEngine}=await import('../custody/sweep-engine.js');
const {feeWalletReport}=await import('../custody/reporting.js');
const app=await buildServer(),engine=new SweepEngine(pool,0);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),address=(s:string)=>'0x'+sha(s).slice(24),hash=(s:string)=>'0x'+sha(s);
const keyId=sha('inert public metadata'),feeAddress=address('fee'),destination=address('collection');
const exact='9007199254740993',statuses=['queued','sponsor_signed','sponsor_pending','sponsored','sweep_signed','sweep_pending','completed','review','dust'];
let cookie='',completed='',firstUser='',sequence=0;
const get=(path:string,auth=cookie)=>app.inject({url:'/api/admin/sweeps'+path,headers:{cookie:auth}});
async function credited(amount=exact){
  const user=randomUUID(),index=++sequence,source=address(user);
  if(!firstUser)firstUser=user;
  await query('insert into users(id,email,username,pass_hash) values($1,$2,$3,$4)',[user,user+'@report.invalid','report_'+index,'fixture']);
  await query('insert into custody_evm_users(key_id,deriv_index,address,user_id) values($1,$2,$3,$4)',[keyId,index,source,user]);
  await query("insert into deposit_addresses(chain_id,custody_kind,custody_key_id,deriv_index,address,user_id) values('ETH','managed',$1,$2,$3,$4)",[keyId,index,source,user]);
  return tx(async c=>{
    const dep=(await c.query(`insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,
      confirmations,required_conf,status,confirmed_at) values('ETH','USDT.ERC20',$1,$2,$3,1,$4,100,$5,5,5,'confirmed',now()) returning id`,[user,source,hash(user),amount,hash('block')])).rows[0];
    assert.equal(await creditConfirmedDeposit(c,dep.id),true);return String(dep.id);
  });
}
before(async()=>{
  await control.query('create database '+name+' template template0');const sql=new URL('../../sql/',import.meta.url);
  for(const f of (await readdir(sql)).filter(f=>f.endsWith('.sql')).sort())await query(await readFile(new URL(f,sql),'utf8'));
  await query(`insert into custody_root(key_id,wrap_spki,sealed_seed,evm_xpub,fee_address,verified_at) values($1,$2,$3,$4,$5,now())`,[keyId,Buffer.from('inert public metadata'),Buffer.alloc(384),'xpub'+'1'.repeat(107),feeAddress]);
  await query("update chains set enabled=true where id='ETH'");await query("update custody_sweep_networks set destination=$1 where chain_id='ETH'",[destination]);await query("update custody_sweep_networks set sweeps_enabled=true where chain_id='ETH'");
  const admin=(await query("insert into admin_users(username,pass_hash) values('report_operator','fixture') returning id")).rows[0];cookie='eb_admin='+await signAdminToken(admin.id);
  for(let n=0;n<33;n++)await credited();await engine.enqueue('ETH');
  const jobs=(await query('select * from custody_sweep_jobs order by id')).rows;
  for(let n=0;n<statuses.length;n++){
    const j=jobs[n],status=statuses[n];
    if(status==='completed'){
      completed=String(j.id);
      // Inert bytes in an isolated database exercise report projection; nothing is broadcast.
      for(const phase of ['sponsor','sweep'])await query(`insert into custody_sweep_steps(job_id,chain_id,phase,txid,raw,signer,amount,fee,nonce,block_number,block_hash,finalized_at,actual_fee)
        values($1,'ETH',$2,$3,$4,$5,$6,5000,$7,105,$8,now(),1234)`,[j.id,phase,hash(j.id+phase),Buffer.from('inert report fixture'),phase==='sponsor'?feeAddress:j.source,phase==='sponsor'?'10000':exact,phase==='sponsor'?'1':'7',hash('final')]);
    }
    if(status!=='queued')await query('update custody_sweep_jobs set status=$2,completed_at=case when $2=\'completed\' then now() end,last_error=case when $2=\'review\' then \'insufficient_funds\'::custody_sweep_reason end where id=$1',[j.id,status]);
  }
  await query("update custody_sweep_networks set sweeps_enabled=false where chain_id='ETH'");
  await credited();await credited('99999');
});
after(async()=>{await app.close();await pool.end();try{await control.query('drop database if exists '+name);}finally{await control.end();}});

test('all reporting endpoints require an operator session and reject invalid filters without server errors',async()=>{
  for(const path of ['', '/jobs','/awaiting','/fee-wallets','/jobs/'+completed])assert.equal((await get(path,'')).statusCode,401);
  const player='eb_sess='+await createSession(firstUser);assert.equal((await get('/jobs',player)).statusCode,401);
  for(const suffix of ['?before=oops','?before=9999999999999999999','?limit=51','?limit=-1','?status=bogus','?chain=BTC','?unknown=1'])assert.equal((await get('/jobs'+suffix)).statusCode,400,suffix);
  assert.equal((await get('/jobs/oops')).statusCode,400);assert.equal((await get('/jobs/999999')).statusCode,404);
});
test('history covers every lifecycle state, searches public receipts and paginates without losing integer precision',async()=>{
  const first=await get('/jobs');assert.equal(first.statusCode,200,first.body);assert.equal(first.headers['cache-control'],'no-store');
  const a=first.json();assert.equal(a.rows.length,25);assert.equal(a.more,true);assert.ok(a.rows.every((r:any)=>r.amount===exact));
  const b=(await get('/jobs?before='+a.next_before)).json();assert.equal(b.rows.length,8);assert.equal(b.more,false);
  const ids=[...a.rows,...b.rows].map(r=>r.id);assert.equal(new Set(ids).size,33);
  for(const status of statuses){const r=await get('/jobs?status='+status);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().rows.length>0);assert.ok(r.json().rows.every((j:any)=>j.status===status));}
  const detail=await get('/jobs/'+completed);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().job.collection_amount,exact);
  assert.deepEqual(detail.json().steps.map((s:any)=>s.phase),['sponsor','sweep']);assert.ok(detail.json().steps.every((s:any)=>s.actual_fee==='1234'&&s.fee==='5000'));
  assert.equal(detail.json().job.fee_recorded,'2468');assert.equal(detail.json().job.fee_reserved,'10000');assert.equal(detail.json().job.missing_fee_receipts,0);
  assert.doesNotMatch(detail.body,/"(?:raw|sealed_seed|enc_dek|ciphertext|wrap_spki)"/);
  const found=(await get('/jobs?q='+detail.json().steps[0].txid)).json();assert.deepEqual(found.rows.map((j:any)=>j.id),[completed]);
  assert.equal((await get('/jobs?chain=POL')).json().rows.length,0);
});
test('uncollected credits show paused and below-minimum reasons while totals distinguish actual collected amounts',async()=>{
  const r=await get('/awaiting');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().rows.length,2);
  assert.deepEqual(r.json().rows.map((v:any)=>v.reason).sort(),['below_minimum','sweeps_paused']);
  assert.ok(r.json().rows.every((v:any)=>v.credited_at&&v.symbol==='USDT'));
  const overview=await get('');assert.equal(overview.statusCode,200,overview.body);
  const d=overview.json();assert.equal(d.counts.reduce((n:number,r:any)=>n+Number(r.count),0),33);
  assert.equal(d.amounts[0].collected,exact);assert.equal(d.amounts[0].outstanding,(BigInt(exact)*31n).toString());
  assert.equal(d.awaiting.reduce((n:bigint,r:any)=>n+BigInt(r.amount),0n),BigInt(exact)+99999n);
});
test('fee wallet snapshots share their refresh budget and preserve verified balances when RPC evidence fails',async()=>{
  const original=globalThis.fetch,calls:{method:string;params:any[]}[]=[],block=hash('canonical fee block');let invalid=false;
  for(const chain of ['ETH','BSC','POL'])await setSecret('rpc:'+chain,'https://'+chain.toLowerCase()+'.report.invalid','fixture');
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.match(url.hostname,/^(eth|bsc|pol)\.report\.invalid$/);
    const body=JSON.parse(String(init?.body));calls.push(body);const network={eth:'0x1',bsc:'0x38',pol:'0x89'}[url.hostname.split('.')[0]!];
    if(invalid)throw Error('fixture unavailable');
    const result=body.method==='eth_chainId'?network:body.method==='eth_getBlockByNumber'?{number:'0x123',hash:block,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)}:'0x20000000000001';
    if(body.method==='eth_getBalance')assert.deepEqual(body.params[1],{blockHash:block,requireCanonical:true});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
  };
  try{
    const baseline=(await query('select id,status,amount::text from custody_sweep_jobs order by id')).rows;
    await Promise.all([feeWalletReport(),feeWalletReport()]);assert.equal(calls.length,9);
    const a=await get('/fee-wallets');assert.equal(a.statusCode,200,a.body);assert.equal(calls.length,9);const eth=a.json().wallets.find((w:any)=>w.chain_id==='ETH');
    assert.equal(eth.status,'current');assert.equal(eth.balance,'9007199254740993');assert.equal(eth.sponsor_budget_used,'15000');assert.equal(eth.address,feeAddress);
    assert.equal(a.json().wallets.find((w:any)=>w.chain_id==='SOL').status,'self_funded');
    const checked=eth.checked_at;invalid=true;await query("update custody_fee_balances set refresh_after='-infinity'");
    const failed=await feeWalletReport(),stale=failed.wallets.find(w=>w.chain_id==='ETH')!;assert.equal(stale.status,'stale');assert.equal(stale.balance,eth.balance);assert.equal(new Date(stale.checked_at).toISOString(),checked);
    await query("update custody_fee_balances set address=null,balance=null,checked_at=null,refresh_after='-infinity' where chain_id='POL'");
    const unknown=(await feeWalletReport()).wallets.find(w=>w.chain_id==='POL')!;assert.equal(unknown.status,'unavailable');assert.equal(unknown.balance,null);
    assert.deepEqual((await query('select id,status,amount::text from custody_sweep_jobs order by id')).rows,baseline);
    assert.equal((await query("select count(*)::int as n from drpc_rpc_chain_health where last_error is not null")).rows[0].n,0);
  }finally{globalThis.fetch=original;}
});
