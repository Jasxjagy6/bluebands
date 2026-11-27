import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../api/server.js';
import { pool,query,tx } from '../db.js';
import { createSession,loginUser } from '../auth-user.js';
import { hashPassword,signAdminToken } from '../authutil.js';
import { balanceOf,creditConfirmedDeposit } from '../ledger.js';
import { startMines,revealMines } from '../games/mines.js';
import { convert,quoteConversion } from '../conversions.js';
import { currentQuote } from '../games/prices.js';
import { installMarketFixture,marketResponse,expireMarket } from './market-fixture.js';

let eth='0.0005';
installMarketFixture(()=>marketResponse({ETH:eth}));
const app=await buildServer(), uid=randomUUID(),other=randomUUID(),name='player'+uid.slice(0,6);
const email=name+'@test.invalid',pass=randomUUID(),base='/api/admin/users/'+uid;
const coin=10n**18n;let admin='',player='',peer='';
const get=(url:string,cookie=player)=>app.inject({url,headers:{cookie}});
const send=(url:string,payload:Record<string,unknown>,cookie=player)=>app.inject({url,method:'POST',payload,headers:{cookie}});
const control=(action:string,data:Record<string,unknown>={})=>({action,request:randomUUID(),reason:'Fixture verification',...data});
const money=async(asset='USDT')=>tx(c=>balanceOf(c,'u:'+uid,asset));
before(async()=>{
  await expireMarket('USDT');
  for(const [id,n] of [[uid,name],[other,'other'+other.slice(0,6)]] as const)
    await query('insert into users(id,username,email,pass_hash) values($1,$2,$3,$4)',[id,n,n+'@test.invalid',hashPassword(pass)]);
  player='eb_sess='+await createSession(uid);peer='eb_sess='+await createSession(other);
  const row=await query("insert into admin_users(username,pass_hash) values($1,'x') returning id",[randomUUID()]);
  admin='eb_admin='+await signAdminToken(Number(row.rows[0].id));
});
after(async()=>{await app.close();await pool.end();});

test('administrator directory finds partial emails, usernames and IDs and exposes only permitted records',async()=>{
  assert.equal((await get('/api/admin/users')).statusCode,401);
  for(const q of [email.toUpperCase(),name.slice(2),uid.slice(0,10)]){
    const d=await get('/api/admin/users?q='+encodeURIComponent(q),admin);
    assert.equal(d.json().rows.some((u:any)=>u.id===uid),true);
    assert.equal(d.json().rows.some((u:any)=>u.pass_hash!==undefined),false);
  }
  assert.equal((await get(base,admin)).json().user.email,email);
  for(const endpoint of ['deposits','withdrawals','bets','transactions','stats','actions']){
    assert.equal((await get(base+'/'+endpoint,admin)).statusCode,200,endpoint);
    assert.equal((await get(base+'/'+endpoint,peer)).statusCode,401,endpoint);
  }
});
test('audited adjustments are idempotent, reject overdraw and do not count as wagers',async()=>{
  const body=control('credit',{asset:'USDT',amount:'1500'});
  const race=await Promise.all([send(base+'/actions',body,admin),send(base+'/actions',body,admin)]);
  assert.deepEqual(race.map(r=>r.statusCode),[200,200]);assert.deepEqual(race[0]!.json(),race[1]!.json());
  assert.equal(await money(),1500n*coin);
  assert.equal((await send(base+'/actions',{...body,amount:'2000'},admin)).statusCode,409);
  assert.equal((await send(base+'/actions',control('debit',{asset:'USDT',amount:'1600'}),admin)).statusCode,409);
  assert.equal((await send(base+'/actions',control('debit',{asset:'USDT',amount:'1.25'}),admin)).statusCode,200);
  assert.equal((await send(base+'/actions',control('credit',{asset:'USDT.ERC20',amount:'1'}),admin)).statusCode,409);
  assert.equal((await get(base+'/actions',admin)).json().rows.length,2);
  assert.equal(Number((await get('/api/me/levels')).json().wagered_usd),0);
  assert.equal((await get(base+'/transactions',admin)).json().rows.length,2);
  assert.deepEqual((await get('/api/me/notifications',peer)).json().rows,[]);
});
test('100 coin levels unlock winter daily packs; old VIP claims are retired without moving balances',async()=>{
  const publicLevels=(await get('/api/reward-levels','')).json();assert.equal(publicLevels.program,'daily_coins');assert.equal(publicLevels.levels.length,100);
  assert.ok(publicLevels.packs.every((p:any)=>! /Bronze|Diamond|Ruby/.test(p.name)));
  const before=await money();assert.equal((await send('/api/me/levels/1/claim',{})).statusCode,410);assert.equal(await money(),before);
  const converted=await quoteConversion(uid,'USDT','crypto_to_coins','1000');await convert(uid,randomUUID(),converted.id);
  const r=await startMines(uid,'COINS','599999.999999999999',25,3,randomUUID());assert.equal((await get('/api/me/rewards')).json().wagered,'0');
  const tile=(await query('select mine_positions from mines_rounds where id=$1',[r.id])).rows[0].mine_positions[0];await revealMines(uid,tile,r.id);
  const progress=(await get('/api/me/rewards')).json();assert.equal(progress.packs[0].ready,true);assert.ok(progress.level>=10);assert.equal(progress.levels.length,100);
  const old=await money('COINS');for(const level of [1,2,3,45])assert.equal((await send('/api/me/levels/'+level+'/claim',{})).statusCode,410);
  assert.equal(await money('COINS'),old);
  const quote=(await currentQuote('COINS')).id,payload={game:'rewards',level:10,asset:'COINS',quote,request:randomUUID()};
  const claim=await send('/api/games/instant',payload);assert.equal(claim.statusCode,200,claim.body);assert.equal(await money('COINS'),old+BigInt(claim.json().payout));
  const again=await send('/api/games/instant',payload);assert.deepEqual(again.json(),claim.json());
  assert.equal((await send('/api/games/instant',{...payload,request:randomUUID()})).statusCode,400);
  assert.equal((await get(base+'/bets/mines/'+r.id,admin)).json().detail['Mine positions'].length,3);
});
test('native conversion locks the live price and later coin wagers keep the fixed coin value',async()=>{
  await send(base+'/actions',control('credit',{asset:'ETH',amount:'1'}),admin);
  await expireMarket('ETH');
  const converted=await quoteConversion(uid,'ETH','crypto_to_coins','0.05');assert.equal(converted.coin_amount,'60000');await convert(uid,randomUUID(),converted.id);
  const r=await startMines(uid,'COINS','60000',25,3,randomUUID());
  eth='0.001';await expireMarket('ETH');await currentQuote('ETH');
  const t=(await query('select mine_positions from mines_rounds where id=$1',[r.id])).rows[0].mine_positions[0];
  await revealMines(uid,t,r.id);
  const value=(await query("select usd from vip_wagers where user_id=$1 and game='mines' and id=$2",[uid,r.id])).rows[0].usd;
  assert.equal(Number(value),100);
  const before=await money('COINS');assert.equal((await send('/api/me/levels/3/claim',{})).statusCode,410);assert.equal(await money('COINS'),before);
});
test('committed deposit events wake the correct player, held deposits require confirmations, read state survives reconnect',async()=>{
  const rev=(await get('/api/me/notifications')).json().revision;
  const waiting=get('/api/me/notifications/changes?after='+rev);
  const response=Promise.resolve(waiting);await delay(25);
  const row=(await query(`insert into deposits(chain_id,asset_id,user_id,address,txid,amount,block_number,status,confirmations,required_conf)
    values('ETH','USDT.ERC20',$1,'fixture',$2,2000000,5,'pending',1,12) returning id`,[uid,randomUUID()])).rows[0];
  assert.equal((await response).json().revision,(BigInt(rev)+1n).toString());
  const before=await money(),hold=control('hold_deposit',{deposit:row.id});
  assert.equal((await send(base+'/actions',hold,admin)).statusCode,200);
  const deposit=(await get(base+'/deposits?pending=true',admin)).json().rows[0];
  assert.equal(deposit.review_hold,true);assert.equal(deposit.confirmations,1);
  assert.equal(await tx(c=>creditConfirmedDeposit(c,row.id)),false);
  await query("update deposits set status='confirmed',confirmations=12 where id=$1",[row.id]);
  assert.equal(await tx(c=>creditConfirmedDeposit(c,row.id)),false);
  assert.equal((await send(base+'/actions',control('release_deposit',{deposit:row.id}),admin)).statusCode,200);
  assert.equal(await tx(c=>creditConfirmedDeposit(c,row.id)),true);assert.equal(await money(),before+2n*coin);
  const d=(await get('/api/me/notifications')).json();
  assert.deepEqual(d.rows.filter((n:any)=>n.reference===row.id).map((n:any)=>n.kind),['deposit.credited','deposit.pending']);
  await send('/api/me/notifications/read',{through:d.revision});assert.equal((await get('/api/me/notifications')).json().unread,0);
  assert.equal((await get('/api/me/notifications?before='+d.revision)).json().rows.some((r:any)=>r.revision===d.revision),false);
  assert.equal((await get('/api/me/notifications',peer)).json().unread,0);
});
test('transaction categories isolate entries before pagination for players and admins',async()=>{
  const request=(await send('/api/me/withdrawals',{request:randomUUID(),route:'USDT.ERC20',destination:'0x'+'31'.repeat(20),amount:'1'})).json();
  assert.ok(request.id);assert.equal((await send('/api/me/withdrawals/'+request.id+'/cancel',{})).statusCode,200);
  const types:Record<string,RegExp>={bets:/^(bet|payout|refund):/,deposits:/^deposit$/,withdrawals:/^withdrawal_(hold|refund)$/,rewards:/^payout:rewards$/,conversions:/^conversion:/,adjustments:/^admin_(credit|debit)$/};
  for(const [type,pattern] of Object.entries(types)){
    const path='/transactions?type='+type,rows=(await get('/api/me'+path)).json().rows;
    assert.ok(rows.length,type);assert.ok(rows.every((n:any)=>pattern.test(n.kind)),type);
    assert.deepEqual((await get(base+path,admin)).json().rows,rows);
    assert.deepEqual((await get('/api/me'+path,peer)).json().rows,[]);
  }
  assert.equal((await get('/api/me/transactions?type=invalid')).statusCode,400);
  assert.equal((await send('/api/games/instant',{game:'rewards',level:10,asset:'USDT',quote:randomUUID(),request:randomUUID()})).statusCode,400);
});
test('suspension, expiry, ban and restore revoke sessions and control new login',async()=>{
  const rev=(await get('/api/me/notifications')).json().revision;
  const poll=Promise.resolve(get('/api/me/notifications/changes?after='+rev));await delay(40);
  assert.equal((await send(base+'/actions',control('suspend',{until:new Date(Date.now()+60000).toISOString()}),admin)).statusCode,200);
  assert.equal((await poll).statusCode,401);await assert.rejects(startMines(uid,'USDT','1',25,3,randomUUID()),/restricted/);
  assert.equal((await get('/api/me/notifications')).statusCode,401);await assert.rejects(loginUser(email,pass));
  assert.equal((await get('/api/admin/users?status=suspended&q='+name,admin)).json().rows[0].id,uid);
  await query("update users set suspended_until=now()-interval '1 second' where id=$1",[uid]);
  const renewed=await loginUser(email,pass);assert.ok(renewed.token);
  await send(base+'/actions',control('ban'),admin);await assert.rejects(loginUser(email,pass));
  assert.equal((await get('/api/me/balances','eb_sess='+renewed.token)).statusCode,401);
  await send(base+'/actions',control('restore'),admin);assert.ok((await loginUser(email,pass)).token);
});
