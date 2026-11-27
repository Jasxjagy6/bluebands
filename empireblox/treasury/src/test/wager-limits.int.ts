import { after,before,beforeEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../api/server.js';
import { createSession } from '../auth-user.js';
import { signAdminToken } from '../authutil.js';
import { quoteConversion,convert } from '../conversions.js';
import { debitStake } from '../bet.js';
import { query,pool,tx } from '../db.js';
import { balanceOf,post } from '../ledger.js';
import { parseAmount } from '../money.js';
import { hashSeed,shuffle } from '../fair.js';
import { readLimits,type Limits } from '../games/wager-limits.js';
import { checkedQuote,currentQuote,marketQuote } from '../games/prices.js';
import { activeMines,cashoutMines,revealMines,startMines } from '../games/mines.js';
import { startBlackjack,actBlackjack,activeBlackjack } from '../games/blackjack.js';
import { instantRound } from '../games/catalog.js';
import { battleAction,createBattle } from '../games/battles.js';
import { expireMarket,installMarketFixture,marketResponse,krakenResponse } from './market-fixture.js';

const coin=10n**18n;
const good=()=>marketResponse({USDT:'1.2',ETH:'0.0006'}); // 1 ETH = USD 1666.66... = 2000 USDT
let response=good,requests=0,tron=()=>krakenResponse(),tronRequests=0;
const restoreFetch=installMarketFixture(()=>{requests++;return response();},init=>{
  tronRequests++;assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.ok(init.signal);
  assert.equal(new Headers(init.headers).has('authorization'),false);return tron();
});
const app=await buildServer();let admin='',original:Limits;
const get=(url:string,cookie='')=>app.inject({url,headers:{cookie}});
const put=(payload:Record<string,unknown>,cookie=admin)=>app.inject({url:'/api/admin/bet-limits',method:'PUT',headers:{cookie},payload});
async function limits(min_usdt:string,max_usdt:string|null) { assert.equal((await put({min_usdt,max_usdt})).statusCode,200); }
async function player() {
  const id=randomUUID();
  await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'fixture')",[id,id+'@test.invalid','lim'+id.slice(0,8)]);
  await tx(c=>post(c,'deposit','limits-fixture',['ETH','USDT','COINS'].flatMap(asset=>[
    {account:'ext:fixture',asset,delta:-(asset==='COINS'?1000000n:1000n)*coin},{account:'u:'+id,asset,delta:(asset==='COINS'?1000000n:1000n)*coin}])));
  return {id,cookie:'eb_sess='+await createSession(id)};
}
const balance=(uid:string,asset='COINS')=>tx(c=>balanceOf(c,'u:'+uid,asset));
const booked=async(uid:string)=>(await query('select * from valued_debits where user_id=$1 order by journal_id',[uid])).rows;
const text=(n:string)=>n.includes('.')?n.replace(/0+$/,'').replace(/\.$/,''):n;
const offline=()=>{throw new Error('Fixture market offline');};
before(async()=>{
  original=await readLimits();
  const a=(await query("insert into admin_users(username,pass_hash) values($1,'fixture') returning id",[randomUUID()])).rows[0];
  admin='eb_admin='+await signAdminToken(Number(a.id));
});
beforeEach(async()=>{
  response=good;requests=0;tron=()=>krakenResponse();tronRequests=0;
  await query('update wager_limits set min_units=0,max_units=null where singleton');
  await expireMarket('ETH');await expireMarket('USDT');await expireMarket('COINS');
});
after(async()=>{
  await query('update wager_limits set min_units=$1,max_units=$2 where singleton',[original.min_units,original.max_units]);
  await expireMarket('ETH');await expireMarket('USDT');await expireMarket('TRX');restoreFetch();await app.close();await pool.end();
});

test('only operators can change the full range; player readback and the audit are exact',async()=>{
  const p=await player(),defaults={min_usdt:'0',max_usdt:null};
  assert.deepEqual((await get('/api/games/bet-limits')).json(),defaults);
  assert.equal((await get('/api/admin/bet-limits',p.cookie)).statusCode,401);
  assert.equal((await put(defaults,p.cookie)).statusCode,401);
  const b={min_usdt:'1.000000000000000001',max_usdt:'1.000000000000000001'};
  assert.deepEqual((await put(b)).json(),b);
  for(const bad of [{min_usdt:'2',max_usdt:'1'},{min_usdt:'1'}, {...b,quote:'client supplied rate'}, {min_usdt:1,max_usdt:null}]){
    assert.equal((await put(bad)).statusCode,400);
  }
  assert.deepEqual((await get('/api/admin/bet-limits',admin)).json(),b);assert.deepEqual((await get('/api/games/bet-limits')).json(),b);
  assert.deepEqual((await query("select detail from audit_log where action='bet_limits.update' order by id desc limit 1")).rows[0].detail,b);
});

test('an admitted stake and its limits are serialized; an issued quote cannot reprice its receipt',async()=>{
  const p=await player(),q=await currentQuote('COINS');await limits('2','2');
  await tx(async c=>{
    await debitStake(c,p.id,'COINS',1200n*coin,'fixture','lock-check',{quote:q.id});
    await assert.rejects(tx(other=>other.query('select singleton from wager_limits where singleton for update nowait')),
      (e:{code?:string})=>e.code==='55P03');
  });
  await limits('3','3');
  await assert.rejects(query('update game_quotes set usdt_per_usd=2 where id=$1',[q.id]),(e:{code?:string})=>e.code==='23514');
  assert.deepEqual((await booked(p.id)).map(d=>text(d.usdt)),['2']);
});

test('unbounded paid entries fail closed on bad, stale or missing market legs; legacy quotes do not authorize',async()=>{
  const p=await player(),key=randomUUID();
  const legacy=(await query("insert into game_quotes(asset_id,unit,minor_per_usd) values('ETH',1000,600000) returning id")).rows[0];
  await assert.rejects(instantRound(p.id,'ETH',legacy.id,randomUUID(),{game:'cases',case:'peppermint'}),/expired/);
  for(const invalid of [offline,()=>new Response('',{status:503}),()=>marketResponse({ETH:'0'}),()=>marketResponse({USDT:undefined}),
    ()=>marketResponse({ETH:0.001}),()=>marketResponse({USDT:'1e0'}),()=>marketResponse({},{age:'120'}),
    ()=>marketResponse({},{date:new Date(Date.now()-130000).toUTCString()}),()=>marketResponse({},{date:new Date(Date.now()+60000).toUTCString()}),
    ()=>Response.json({data:{currency:'EUR',rates:{ETH:'1',USDT:'1'}}},{headers:{date:new Date().toUTCString()}})]){
    response=invalid;
    const r=await app.inject({url:'/api/me/conversions/quote',method:'POST',headers:{cookie:p.cookie},payload:{asset:'ETH',direction:'crypto_to_coins',amount:'1'}});
    assert.equal(r.statusCode,503);assert.match(r.json().error,/Market price/);
  }
  assert.equal(await balance(p.id),1000000n*coin);assert.equal(await activeMines(p.id),null);assert.deepEqual(await booked(p.id),[]);
  response=good;
  const q=await currentQuote('ETH');assert.equal(q.unit,'1000000000000');assert.equal(q.usdt_per_usd,'1.2');
  assert.ok(+q.expires_at-+q.quoted_at<=120000);assert.equal((await currentQuote('ETH')).id,q.id);
  await tx(async c=>{
    // Transaction now() predates this expiry. A wall-clock gate must still reject it.
    await c.query('update game_quotes set expires_at=clock_timestamp() where id=$1',[q.id]);
    assert.equal((await c.query('select expires_at>now() as would_pass from game_quotes where id=$1',[q.id])).rows[0].would_pass,true);
    await assert.rejects(checkedQuote(c,q.id,'ETH'),/expired/);
  });
  // Catalog rounding must not prevent a player-denominated stake valuation.
  response=()=>marketResponse({ETH:'0.000000000000000000000001',USDT:'1.2'});
  assert.equal((await marketQuote(pool,'ETH')).unit,'0');await assert.rejects(currentQuote('ETH'),/Market price/);
  await assert.rejects(startMines(p.id,'ETH','0.000000000000000001',25,3,key),/Unknown currency/);
  assert.equal((await quoteConversion(p.id,'ETH','crypto_to_coins','0.000000000000000001')).coin_amount,'720000000');
});

test('Mines enforce exact coin boundaries, preserve replay/cashout, and freeze coin progress independently of the market',async()=>{
  const p=await player(),key=randomUUID();await limits('120','120');
  for(const [bet,error] of [['71999.999999999999999999',/Minimum/],['72000.000000000000000001',/Maximum/]] as const)
    await assert.rejects(startMines(p.id,'COINS',bet,25,3,key),error);
  const m=await startMines(p.id,'COINS','72000',25,3,key);
  assert.equal(text((await get('/api/me/levels',p.cookie)).json().wagered_usdt),'0');
  await expireMarket('COINS');response=offline;await limits('900','901');const calls=requests;
  assert.deepEqual(await startMines(p.id,'COINS','72000',25,3,key),m);
  const mines=(await query('select mine_positions from mines_rounds where id=$1',[m.id])).rows[0].mine_positions as number[];
  await revealMines(p.id,Array.from({length:25},(_,i)=>i).find(i=>!mines.includes(i))!,m.id);await cashoutMines(p.id,m.id);assert.equal(requests,calls);
  await limits('120','120');const stable=await startMines(p.id,'COINS','72000',25,3);
  await revealMines(p.id,(await query('select mine_positions[1] as tile from mines_rounds where id=$1',[stable.id])).rows[0].tile,stable.id);
  response=()=>marketResponse({ETH:'0.001',USDT:'0.8'});await currentQuote('ETH');
  const rewards=(await get('/api/me/levels',p.cookie)).json();assert.equal(text(rewards.wagered_usdt),'240');assert.equal(text(rewards.wagered_usd),'240');assert.equal(rewards.unpriced_usdt,0);
  assert.deepEqual((await get('/api/admin/users/'+p.id,admin)).json().rewards,rewards);
  const stats=(await get('/api/me/stats?asset=COINS',p.cookie)).json().days.at(-1);assert.equal(stats.stake,(144000n*coin).toString());
  assert.deepEqual((await get('/api/admin/users/'+p.id+'/stats?asset=COINS',admin)).json().days.at(-1),stats);
});

test('only TRX uses Kraken: recurring USD reciprocals preserve an exact depegged wagering boundary',async()=>{
  const assets=['BNB','BTC','ETH','POL','SOL','USDT','TRX'];
  await Promise.all(assets.map(expireMarket));
  const quotes=await Promise.all(assets.map(asset=>get('/api/quote/'+asset)));
  assert.deepEqual(quotes.map(r=>r.statusCode),assets.map(()=>200));assert.equal(tronRequests,1);assert.ok(requests>=1);
  for(const [i,r] of quotes.slice(0,6).entries()){
    assert.equal(r.json().asset_id,assets[i]);assert.equal(r.json().usdt_per_usd,'1.2'); // Coinbase fixture, which has no TRX
  }
  const q=quotes[6]!.json();assert.equal(q.asset_id,'TRX');assert.equal(q.unit,'5376');
  assert.equal(Date.parse(q.expires_at)-Date.parse(q.quoted_at),120000);
  const base=parseAmount(q.minor_per_usd,24),stable=parseAmount(q.usdt_per_usd,24),scale=10n**24n;
  // Midpoints $0.31/TRX and $1.03/USDT. Neither reciprocal is a finite decimal.
  assert.equal(103n*1000000n*stable,31n*base);
  const usdError=base*31n-100000000n*scale;
  assert.ok((usdError<0n?-usdError:usdError)*10n**16n<=100000000n*scale);
  const p=await player();await tx(c=>post(c,'deposit','tron-fixture',[
    {account:'u:'+p.id,asset:'TRX',delta:200000000n},{account:'ext:fixture',asset:'TRX',delta:-200000000n}]));
  const conversion=await quoteConversion(p.id,'TRX','crypto_to_coins','103');assert.equal(conversion.coin_amount,'18600');
  await convert(p.id,randomUUID(),conversion.id);await limits('31','31');
  await assert.rejects(startMines(p.id,'COINS','18599.999999999999999999',25,3),/Minimum/);
  await assert.rejects(startMines(p.id,'COINS','18600.000000000000000001',25,3),/Maximum/);
  await limits('0','30.999999999999999999');await assert.rejects(startMines(p.id,'COINS','18600',25,3),/Maximum/);
  await limits('31.000000000000000001',null);await assert.rejects(startMines(p.id,'COINS','18600',25,3),/Minimum/);
  await limits('31','31');await startMines(p.id,'COINS','18600',25,3);
  const [debit]=await booked(p.id);assert.equal(text(debit.usdt),'31');assert.equal(tronRequests,1);
  assert.equal((await query('select market_quote_id from conversion_quotes where id=$1',[conversion.id])).rows[0].market_quote_id,q.id);
});

test('TRX rejects stale, partial, crossed or unrepresentable books without borrowing a Coinbase leg',async()=>{
  await expireMarket('TRX');const q=await currentQuote('TRX');await expireMarket('TRX');
  response=()=>marketResponse({TRX:'99',USDT:'1'}); // must not be consulted, even on an error
  const book=(bid:unknown,ask=bid,close=bid)=>({b:[bid],a:[ask],c:[close]});
  for(const invalid of [offline,()=>new Response(null,{status:429}),()=>new Response('bad JSON'),
    ()=>Response.json({error:['EQuery:Unknown asset pair'],result:{TRXUSD:book('0.31'),USDTZUSD:book('1.03')}},{headers:{date:new Date().toUTCString()}}),
    ()=>krakenResponse({TRXUSD:undefined}),()=>krakenResponse({USDTZUSD:undefined,TRXUSDT:book('1')}),
    ()=>krakenResponse({USDTZUSD:{b:['1'],c:['1']}}),()=>krakenResponse({TRXUSD:book('0')}),
    ()=>krakenResponse({TRXUSD:book('0.32','0.31')}),()=>krakenResponse({USDTZUSD:book('1','1','NaN')}),
    ()=>krakenResponse({TRXUSD:book(0.31)}),()=>krakenResponse({USDTZUSD:book('1e0')}),
    ()=>krakenResponse({TRXUSD:book('0.310000000000000000000001'),USDTZUSD:book('1.030000000000000000000007')}),
    ()=>krakenResponse({},{date:'invalid'}),()=>krakenResponse({},{age:'120'}),
    ()=>krakenResponse({},{date:new Date(Date.now()-130000).toUTCString()}),()=>krakenResponse({},{date:new Date(Date.now()+60000).toUTCString()})]){
    tron=invalid;assert.equal((await get('/api/quote/TRX')).statusCode,503);
  }
  assert.equal(requests,0);await assert.rejects(checkedQuote(pool,q.id,'TRX'),/expired/);
  assert.equal((await query("select 1 from game_quotes where asset_id='TRX' and expires_at>clock_timestamp() and quoted_at is not null")).rowCount,0);
  tron=()=>krakenResponse({},{age:'90'});const next=await currentQuote('TRX');
  assert.notEqual(next.id,q.id);assert.ok(+next.expires_at-Date.now()<=30000);assert.equal(requests,0);
});

async function deal(uid:string,matches:(shoe:number[])=>boolean) {
  const client='limits';let seed='';
  for(let i=0;i<10000;i++){const s='limits-'+i;if(matches(shuffle(312,s,client,0).map(n=>n%52))){seed=s;break;}}
  assert.ok(seed);
  await query('insert into user_fair(user_id,server_seed,server_seed_hash,client_seed,nonce) values($1,$2,$3,$4,0)',[uid,seed,hashSeed(seed),client]);
  return startBlackjack(uid,'COINS','7200',randomUUID());
}
test('blackjack splits and doubles enforce cumulative coin exposure with a fresh fixed quote for each paid addition',async()=>{
  const p=await player();await limits('12','24');
  const r=await deal(p.id,s=>s[0]!%13===4&&s[2]!%13===4&&s[1]!%13>0&&s[1]!%13<9);assert.equal(r.can_split,true);
  const before=await balance(p.id);await expireMarket('COINS');response=offline;
  await limits('12','23.999999999999999999');await assert.rejects(actBlackjack(p.id,r.id,0,'split'),/Maximum/);
  assert.deepEqual(await activeBlackjack(p.id),r);assert.equal(await balance(p.id),before);
  await limits('12','24');const split=await actBlackjack(p.id,r.id,0,'split');assert.equal(split.hands.length,2);
  await limits('12','35.999999999999999999');await assert.rejects(actBlackjack(p.id,r.id,1,'double'),/Maximum/);
  await limits('12','36');const doubled=await actBlackjack(p.id,r.id,1,'double');
  await expireMarket('COINS');await limits('100','100');const calls=requests;
  assert.deepEqual(await actBlackjack(p.id,r.id,1,'double'),doubled);if(doubled.status!=='done')assert.equal((await actBlackjack(p.id,r.id,2,'stand')).status,'done');
  assert.equal(requests,calls);assert.deepEqual((await booked(p.id)).map(r=>text(r.usdt)),['12','12','12']);
  const progress=(await get('/api/me/levels',p.cookie)).json();assert.equal(text(progress.wagered_usdt),'36');assert.equal(text(progress.wagered_usd),'36');
});

test('insurance checks its own minimum and the hand maximum, but declining and natural settlement never debit extra',async()=>{
  const p=await player(),other=await player();const natural=(s:number[])=>s[1]!%13===0 && s[3]!%13>=9;
  await limits('12','18');const r=await deal(p.id,natural),n=await deal(other.id,natural);
  assert.equal(r.status,'insurance');await assert.rejects(actBlackjack(p.id,r.id,0,'insure'),/Minimum/);
  await limits('1','17.999999999999999999');await assert.rejects(actBlackjack(p.id,r.id,0,'insure'),/Maximum/);
  await limits('6','18');assert.equal((await actBlackjack(p.id,r.id,0,'insure')).status,'done');
  assert.deepEqual((await booked(p.id)).map(r=>text(r.usdt)),['12','6']);
  response=offline;await expireMarket('ETH');await limits('99','99');const calls=requests;
  assert.equal((await actBlackjack(other.id,n.id,0,'no_insure')).status,'done');assert.equal(requests,calls);
  assert.equal((await booked(other.id)).length,1);
});

test('cases, upgrader and battle creation check exact coin debits; free reward prizes do not count as wagers',async()=>{
  const p=await player(),q=await currentQuote('COINS'),key=randomUUID();
  const open=()=>instantRound(p.id,'COINS',q.id,key,{game:'cases',case:'peppermint'});
  await limits('1.666666666666666667',null);await assert.rejects(open(),/Minimum/);
  await limits('0','1.666666666666666666');await assert.rejects(open(),/Maximum/);
  await limits('1.666666666666666666','1.666666666666666667');const receipt=await open();assert.equal(receipt.stake,(1000n*coin).toString());
  const upgrade=()=>instantRound(p.id,'COINS',q.id,randomUUID(),{game:'upgrader',bet:'300',item:21070012,over:true});
  await assert.rejects(upgrade(),/Minimum/);await limits('0','0.499999999999999999');await assert.rejects(upgrade(),/Maximum/);
  await limits('0.5','0.5');await upgrade();await limits('1','1.6');
  const b={mode:'3way',cases:['peppermint'],asset:'COINS',quote:q.id,request:randomUUID(),crazy:false,jackpot:false,borrow:0};
  await assert.rejects(createBattle(p.id,b),/Maximum/);await assert.rejects(createBattle(p.id,{...b,borrow:51}),/Minimum/);
  await query('update users set catalog_wagered=(select xp from levels where level=10) where id=$1',[p.id]);
  await limits('1000','1000');await instantRound(p.id,'COINS',q.id,randomUUID(),{game:'rewards',level:10});
  await expireMarket('COINS');response=offline;assert.deepEqual(await open(),receipt);assert.equal((await booked(p.id)).length,2);
});

test('late battle seats keep fixed coin terms; bots, refunds and cancelled entries add no wager progress',async()=>{
  const host=await player(),guest=await player(),q=await currentQuote('COINS');
  const setup={mode:'3way',cases:['peppermint'],asset:'COINS',quote:q.id,request:randomUUID(),crazy:false,jackpot:false,borrow:50};
  await limits('0.833333333333333333','0.833333333333333334');const original=await balance(host.id),{id}=await createBattle(host.id,setup);
  const cancelled=await createBattle(host.id,{...setup,request:randomUUID()});await expireMarket('COINS');response=offline;
  await limits('0','0.8');await assert.rejects(battleAction(guest.id,id,'join',1,50,'COINS'),/Maximum/);
  assert.deepEqual((await query('select seats from battles where id=$1',[id])).rows[0].seats,[host.id,null,null]);
  await limits('0.833333333333333333','0.833333333333333334');await battleAction(guest.id,id,'join',1,50,'COINS');await battleAction(guest.id,cancelled.id,'join',1,50,'COINS');
  await expireMarket('COINS');await limits('900','900');const calls=requests;
  await battleAction(host.id,cancelled.id,'cancel',null,0);assert.equal(await balance(host.id),original-500n*BigInt(q.unit));
  await battleAction(host.id,id,'bots',null,0);assert.equal(requests,calls);
  for(const p of [host,guest]){
    const rewards=(await get('/api/me/levels',p.cookie)).json();assert.equal(text(rewards.wagered_usdt),'0.833333333333333333');
    assert.equal((await query('select catalog_wagered from users where id=$1',[p.id])).rows[0].catalog_wagered,'500');assert.equal((await booked(p.id)).length,2);
  }
});

test('old crypto hands finish without new crypto debits or guessed historical rates',async()=>{
  for(const asset of ['USDT.ERC20','ETH']){
    const p=await player(),id=randomUUID(),stake=asset==='ETH'?'6000000000000000':'1000000';
    const state={dealer:[9,7],hands:[{cards:[4,5],bet:stake}],pos:4,active:0,insurance:'0',payout:'0'};
    await query(`insert into blackjack_rounds(id,user_id,request_id,asset_id,bet,shoe,state,status,server_seed,server_seed_hash,client_seed,nonce)
      values($1,$2,$3,$4,$5,$6,$7,'playing','seed','hash','client',0)`,[id,p.id,randomUUID(),asset,stake,[4,9,5,7,9],state]);
    await limits('0','2');const b=await balance(p.id,asset==='ETH'?'ETH':'USDT');
    await assert.rejects(actBlackjack(p.id,id,0,'double'),/New wagers use coins/);assert.equal(await balance(p.id,asset==='ETH'?'ETH':'USDT'),b);
    const calls=requests;await actBlackjack(p.id,id,0,'stand');assert.equal(requests,calls);
    assert.equal((await get('/api/me/levels',p.cookie)).json().unpriced_usdt,asset==='ETH'?1:0);assert.equal((await booked(p.id)).length,0);
  }
});
