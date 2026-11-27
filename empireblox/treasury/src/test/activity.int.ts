import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildServer } from '../api/server.js';
import { pool, query, tx } from '../db.js';
import { createSession } from '../auth-user.js';
import { signAdminToken } from '../authutil.js';
import { balanceOf, creditConfirmedDeposit, post } from '../ledger.js';
import { quoteConversion,convert } from '../conversions.js';
import { actBlackjack, startBlackjack } from '../games/blackjack.js';
import { startMines, revealMines, cashoutMines } from '../games/mines.js';
import { installMarketFixture } from './market-fixture.js';

installMarketFixture();
const app=await buildServer(), owner=randomUUID(), other=randomUUID();
const coin=10n**18n, users:string[]=[], admins:string[]=[];
const destination='0x'+'1a'.repeat(20);
const get=(url:string,cookie=users[0])=>app.inject({url,headers:{cookie}});
const send=(url:string,payload:Record<string,unknown>|undefined,cookie=users[0])=>
  app.inject({method:'POST',url,headers:{cookie},payload});
const balance=(uid=owner)=>tx(c=>balanceOf(c,'u:'+uid,'USDT'));
const withdrawal=(amount:string, request=randomUUID(),route='USDT.ERC20')=>({route,amount,request,destination});
before(async()=>{
  for(const uid of [owner,other]){
    await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'x')",[uid,uid+'@test.invalid','act'+uid.slice(0,8)]);
    users.push('eb_sess='+await createSession(uid));
    const row=await query("insert into admin_users(username,pass_hash) values($1,'x') returning id",[uid]);
    admins.push('eb_admin='+await signAdminToken(Number(row.rows[0].id)));
  }
});
after(async()=>{await app.close();await pool.end();});

test('four deposit routes credit one crypto USDT balance with exact units, once per deposit',async()=>{
  const catalog=(await get('/api/assets')).json();
  assert.deepEqual(catalog.walletCurrencies.filter((a:any)=>a.symbol==='USDT').map((a:any)=>a.id),['USDT']);
  assert.deepEqual(catalog.transferRoutes.filter((a:any)=>a.symbol==='USDT').map((a:any)=>a.chain_id).sort(),['BSC','ETH','POL','SOL']);
  for(const [chain,asset,units] of [['ETH','USDT.ERC20','1234567'],['BSC','USDT.BEP20','1'],['SOL','USDT.SPL','2000000'],['POL','USDT.POL','3000000']]){
    const dep=await query(`insert into deposits(chain_id,asset_id,user_id,address,txid,amount,block_number,status,required_conf,confirmations)
      values($1,$2,$3,'fixture',$4,$5,10,'confirmed',12,12) returning id`,[chain,asset,owner,randomUUID(),units]);
    const credits=await Promise.all([1,2].map(()=>tx(c=>creditConfirmedDeposit(c,dep.rows[0].id))));
    assert.deepEqual(credits.sort(),[false,true]);
  }
  assert.equal(await balance(),6234567000000000001n);
  const entries=(await get('/api/me/transactions?asset=USDT')).json().rows;
  assert.equal(entries.length,4);assert.ok(entries.every((e:any)=>e.asset_id==='USDT' && e.txid));
  assert.deepEqual(entries.map((e:any)=>e.chain_id).sort(),['BSC','ETH','POL','SOL']);
  await assert.rejects(startMines(owner,'USDT.ERC20','1',25,3),/Unknown currency/);
  await assert.rejects(startBlackjack(owner,'USDT.SPL','1',randomUUID()),/Unknown currency/);
});

test('migration preserves old balances and preferences and can be applied again without moving money twice',async()=>{
  const sql=await readFile(new URL('../../sql/011_unified_usdt.sql',import.meta.url),'utf8');
  await tx(async c=>{
    await c.query('alter table balances disable trigger consolidate_usdt_after_credit');
    for(const [asset,units] of [['USDT.ERC20',1234567n],['USDT.BEP20',1n]] as const)
      await post(c,'deposit','legacy-fixture',[{asset,account:'u:'+other,delta:units},{asset,account:'ext:fixture',delta:-units}]);
    await c.query("update users set display_ccy='USDT.ERC20' where id=$1",[other]);
    await c.query('alter table balances enable trigger consolidate_usdt_after_credit');
    await c.query(sql);await c.query(sql);
    assert.equal(await balanceOf(c,'u:'+other,'USDT'),1234567000000000001n);
    assert.equal(await balanceOf(c,'u:'+other,'USDT.ERC20'),0n);
    assert.equal((await c.query('select display_ccy from users where id=$1',[other])).rows[0].display_ccy,'USDT');
  });
});
test('legacy Blackjack rejects additional crypto exposure but can stand and settle in old units',async()=>{
  const id=randomUUID(), before=await balance(other);
  // This hand's opening stake was charged before consolidation. Player 11 doubles to 21, dealer stands on 18.
  await query(`insert into blackjack_rounds(id,user_id,request_id,asset_id,bet,shoe,state,status,server_seed,server_seed_hash,client_seed,nonce)
    values($1,$2,$3,'USDT.ERC20',1000000,$4,$5,'playing','secret','hash','client',0)`,
    [id,other,randomUUID(),[4,9,5,7,9],{dealer:[9,7],hands:[{cards:[4,5],bet:'1000000'}],pos:4,active:0,insurance:'0',payout:'0'}]);
  const detail=await get('/api/me/bets/blackjack/'+id,users[1]);
  assert.deepEqual(detail.json().detail['Dealer cards'],[9]);assert.ok(!detail.body.includes('secret'));
  await assert.rejects(actBlackjack(other,id,0,'double'),/New wagers use coins/);
  const round=await actBlackjack(other,id,0,'stand');assert.equal(round.payout,'0');
  await actBlackjack(other,id,0,'stand');assert.equal(await balance(other),before);
  const settled=(await get('/api/me/bets/blackjack/'+id,users[1])).json();
  assert.deepEqual(settled.detail['Dealer cards'],[9,7]);assert.equal(settled.stake,'1000000');
  assert.equal((await get('/api/me/bets/blackjack/'+id)).statusCode,404);
  const stats=(await get('/api/me/stats?asset=USDT&days=7',users[1])).json();
  assert.equal(stats.days.at(-1).stake,coin.toString());assert.equal(stats.days.at(-1).payout,'0');
});
test('private bets, UTC statistics and transaction history isolate owners, periods and pages',async()=>{
  const noSession=await app.inject('/api/me/stats');
  assert.equal(noSession.statusCode,401);
  const conversion=await quoteConversion(owner,'USDT','crypto_to_coins','1');await convert(owner,randomUUID(),conversion.id);
  const round=await startMines(owner,'COINS','1',25,3);
  const path='/api/me/bets/mines/'+round.id;
  const active=(await get(path)).json();
  assert.equal(active.detail['Mine positions'],null);assert.equal(active.server_seed,undefined);
  assert.equal((await get(path,users[1])).statusCode,404);
  const mines=(await query('select mine_positions from mines_rounds where id=$1',[round.id])).rows[0].mine_positions as number[];
  const safe=Array.from({length:25},(_,i)=>i).find(i=>!mines.includes(i))!;
  await revealMines(owner,safe);const result=await cashoutMines(owner);
  const done=(await get(path)).json();assert.equal(done.payout,result.payout);
  assert.deepEqual(done.detail['Revealed tiles'],[safe+1]);assert.deepEqual(done.detail['Mine positions'],mines.map(i=>i+1));
  assert.equal((await get('/api/me/bets?game=mines')).json().rows.length,1);
  assert.equal((await get('/api/me/bets?page=-1')).statusCode,400);
  for(const days of [7,30,90]){
    const r=(await get('/api/me/stats?days='+days+'&asset=COINS')).json();
    assert.equal(r.days.length,days);assert.equal(r.days[0].bets,0);assert.equal(r.days.at(-1).wins,1);
    assert.equal(r.days.at(-1).stake,coin.toString());assert.equal(r.days.at(-1).payout,result.payout);
    assert.equal(r.days.at(-1).day,new Date().toISOString().slice(0,10));
  }
  assert.equal((await get('/api/me/stats?days=8')).statusCode,400);
  await tx(async c=>{
    for(let i=0;i<21;i++)await post(c,'deposit','page-'+i,[{asset:'ETH',account:'u:'+owner,delta:1n},{asset:'ETH',account:'ext:ETH',delta:-1n}]);
  });
  const first=(await get('/api/me/transactions?asset=ETH')).json(),last=(await get('/api/me/transactions?asset=ETH&page=1')).json();
  assert.equal(first.rows.length,20);assert.equal(first.more,true);assert.equal(last.rows.length,1);assert.equal(last.more,false);
  const filtered=(await get('/api/me/transactions?asset=ETH&type=deposits')).json();
  const next=(await get('/api/me/transactions?asset=ETH&type=deposits&page=1')).json();
  const deposits=[...first.rows,...last.rows].filter(e=>e.kind==='deposit');
  assert.deepEqual([...filtered.rows,...next.rows],deposits);
  assert.equal(new Set([...first.rows,...last.rows].map(e=>e.id)).size,21);
  assert.deepEqual((await get('/api/me/transactions?asset=ETH',users[1])).json().rows,[]);
});
test('withdrawal requests enforce network precision, prevent overdraw, replay safely and refund once',async()=>{
  const path='/api/me/withdrawals',before=await balance(),request=withdrawal('1');
  for(const bad of [withdrawal('0'),withdrawal('0.0000001'),withdrawal('100000000'),withdrawal('1',randomUUID(),'USDT.TRC20'),
    {...request,destination:'invalid address'}])assert.equal((await send(path,bad)).statusCode,400);
  const replies=await Promise.all([send(path,request),send(path,request)]);
  assert.equal(replies[0]!.statusCode,200);assert.deepEqual(replies[0]!.json(),replies[1]!.json());
  assert.equal((await send(path,{...request,amount:'2'})).statusCode,400);
  const id=replies[0]!.json().id;
  assert.equal(await balance(),before-coin);
  const large=await Promise.all([send(path,withdrawal('4')),send(path,withdrawal('4'))]);
  assert.deepEqual(large.map(r=>r.statusCode).sort(),[200,400]);
  const extra=large.find(r=>r.statusCode===200)!.json().id;
  assert.equal((await send(path+'/'+extra+'/cancel',undefined)).statusCode,200);
  assert.equal((await send(path+'/'+id+'/cancel',undefined,users[1])).statusCode,409);
  assert.equal((await get(path,users[1])).json().rows.length,0);
  const cancellations=await Promise.all([send(path+'/'+id+'/cancel',undefined),send(path+'/'+id+'/cancel',undefined)]);
  assert.deepEqual(cancellations.map(r=>r.statusCode).sort(),[200,409]);assert.equal(await balance(),before);
  assert.equal((await send(path,withdrawal('0.000000000000000001',randomUUID(),'USDT.BEP20'))).statusCode,200);
});
test('an assigned administrator can record an external transfer once or return the reserve',async()=>{
  const path='/api/me/withdrawals',adminPath='/api/admin/withdrawals',before=await balance();
  assert.equal((await get(adminPath)).statusCode,401);
  const id=(await send(path,withdrawal('1'))).json().id;
  const action=(id:string,a:string,admin:string,hash?:string)=>send(adminPath+'/'+id,{action:a,txid:hash},admin);
  const claims=await Promise.all(admins.map(cookie=>action(id,'review',cookie)));
  assert.deepEqual(claims.map(r=>r.statusCode).sort(),[200,409]);
  const winner=claims.findIndex(r=>r.statusCode===200),admin=admins[winner]!,peer=admins[1-winner]!;
  const hash='0x'+'ab'.repeat(32);
  assert.equal((await send(path+'/'+id+'/cancel',undefined)).statusCode,409);
  assert.equal((await action(id,'sent',peer,hash)).statusCode,409);
  assert.equal((await action(id,'sent',admin,hash)).statusCode,409);
  assert.equal((await action(id,'approve',admin)).statusCode,200);
  assert.equal((await action(id,'sent',admin,'invalid')).statusCode,409);
  assert.equal((await action(id,'sent',admin,hash)).statusCode,200);
  assert.equal((await action(id,'sent',admin,hash)).statusCode,409);
  const duplicate=(await send(path,withdrawal('1'))).json().id;
  await action(duplicate,'review',admin);await action(duplicate,'approve',admin);
  assert.equal((await action(duplicate,'sent',admin,hash.toUpperCase())).statusCode,409);
  assert.equal((await action(duplicate,'return',admin)).statusCode,200);
  assert.equal(await balance(),before-coin);
  const history=(await get(path)).json().rows.find((r:any)=>r.id===id);
  assert.equal(history.status,'sent');assert.equal(history.txid,hash);
  const entry=(await get('/api/me/transactions?asset=USDT')).json().rows.find((r:any)=>r.ref===id);
  assert.equal(entry.withdrawal_status,'sent');assert.equal(entry.txid,hash);
  assert.equal((await query("select count(*) as n from audit_log where detail->>'id'=$1",[id])).rows[0].n,'3');
  assert.equal((await query('select journal_id from ledger_entries group by journal_id,asset_id having sum(delta)<>0')).rowCount,0);
});
