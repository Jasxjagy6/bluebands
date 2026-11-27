import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../api/server.js';
import { createSession } from '../auth-user.js';
import { pool,query,tx } from '../db.js';
import { balanceOf,creditConfirmedDeposit,post } from '../ledger.js';
import { quoteConversion,convert } from '../conversions.js';
import { COIN_SCALE as UNIT } from '../coins.js';
import { currentQuote } from '../games/prices.js';
import { startMines,revealMines,cashoutMines,minesPayout } from '../games/mines.js';
import { actBlackjack } from '../games/blackjack.js';
import { instantRound } from '../games/catalog.js';
import { createBattle,battleAction } from '../games/battles.js';
import { coinLeaderboard,settleCoinSeasons,WEEKLY_PRIZES } from '../games/leaderboard.js';
import { installMarketFixture,marketResponse,expireMarket } from './market-fixture.js';

let offline=false,fetches=0;
installMarketFixture(()=>{fetches++;if(offline)throw new Error('Market offline');return marketResponse({USDT:'1.2',ETH:'0.0006'});});
const app=await buildServer();
const funds=(uid:string,asset:string)=>tx(c=>balanceOf(c,'u:'+uid,asset));
const send=(cookie:string,url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,headers:{cookie},payload});
async function player(crypto=10n*UNIT,coins=0n){
  const id=randomUUID();await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'fixture')",[id,id+'@coins.invalid','coin'+id.replaceAll('-','').slice(0,12)]);
  await tx(async c=>{for(const [asset,delta] of [['USDT',crypto],['COINS',coins]] as const)if(delta)await post(c,'fixture:funding',id,[{account:'ext:fixture',asset,delta:-delta},{account:'u:'+id,asset,delta}]);});
  return {id,cookie:'eb_sess='+await createSession(id)};
}
before(async()=>{await query('update wager_limits set min_units=0,max_units=null');});
after(async()=>{await app.close();await pool.end();});

test('catalog separates playable coins from unchanged crypto routes; a confirmed deposit stays crypto',async()=>{
  const p=await player(0n),catalog=(await app.inject('/api/assets')).json();
  assert.deepEqual(catalog.currencies.map((a:any)=>a.id),['COINS']);
  assert.ok(catalog.walletCurrencies.some((a:any)=>a.id==='USDT'));
  assert.equal(catalog.directRoutes.length,7);assert.ok(!catalog.transferRoutes.some((a:any)=>a.id==='COINS'));
  const d=(await query(`insert into deposits(chain_id,asset_id,user_id,address,txid,amount,block_number,status,required_conf,confirmations)
    values('ETH','USDT.ERC20',$1,'fixture',$2,10000000,10,'confirmed',5,5) returning id`,[p.id,randomUUID()])).rows[0];
  assert.deepEqual((await Promise.all([tx(c=>creditConfirmedDeposit(c,d.id)),tx(c=>creditConfirmedDeposit(c,d.id))])).sort(),[false,true]);
  assert.equal(await funds(p.id,'USDT'),10n*UNIT);assert.equal(await funds(p.id,'COINS'),0n);
  assert.equal((await query('select display_ccy from users where id=$1',[p.id])).rows[0].display_ccy,'COINS');
});

test('10 USDT converts to exactly 6,000 coins and back with no fee, balanced journals and receipts',async()=>{
  const p=await player(),q=await quoteConversion(p.id,'USDT','crypto_to_coins','10');
  assert.equal(q.coin_amount,'6000');assert.equal(q.crypto_amount,'10');assert.equal(q.fee,'0');
  const receipt=await convert(p.id,randomUUID(),q.id);
  assert.equal(await funds(p.id,'USDT'),0n);assert.equal(await funds(p.id,'COINS'),6000n*UNIT);
  const reverse=await quoteConversion(p.id,'USDT','coins_to_crypto','6000');assert.equal(reverse.crypto_amount,'10');
  await convert(p.id,randomUUID(),reverse.id);
  assert.equal(await funds(p.id,'USDT'),10n*UNIT);assert.equal(await funds(p.id,'COINS'),0n);
  const totals=await query('select asset_id,sum(delta)::text as total,count(*)::int as legs from ledger_entries where journal_id=$1 group by asset_id',[receipt.journal_id]);
  assert.deepEqual(totals.rows.map(r=>[r.total,r.legs]),[['0',2],['0',2]]);
  const h=(await app.inject({url:'/api/me/conversions',headers:{cookie:p.cookie}})).json();assert.equal(h.rows.length,2);
  assert.equal(h.rows[0].quote.direction,'coins_to_crypto');assert.ok(h.rows.every((r:any)=>r.conversion_id&&r.journal_id));
});

test('native conversions use both live legs from one snapshot, in both directions',async()=>{
  const p=await player(0n);await tx(c=>post(c,'fixture:funding',p.id,[{account:'ext:fixture',asset:'ETH',delta:-UNIT},{account:'u:'+p.id,asset:'ETH',delta:UNIT}]));
  await expireMarket('ETH');const n=fetches;
  const q=await quoteConversion(p.id,'ETH','crypto_to_coins','0.005');
  assert.equal(q.coin_amount,'6000');assert.equal(fetches,n+1);
  await convert(p.id,randomUUID(),q.id);
  const reverse=await quoteConversion(p.id,'ETH','coins_to_crypto','6000');assert.equal(reverse.crypto_amount,'0.005');assert.equal(fetches,n+1);
  await convert(p.id,randomUUID(),reverse.id);assert.equal(await funds(p.id,'ETH'),UNIT);assert.equal(await funds(p.id,'COINS'),0n);
});

test('a retry executes once; a consumed quote and a reused key cannot buy another conversion',async()=>{
  const p=await player(),q=await quoteConversion(p.id,'USDT','crypto_to_coins','5'),key=randomUUID();
  const receipts=await Promise.all(Array.from({length:8},()=>convert(p.id,key,q.id)));
  assert.equal(new Set(receipts.map(r=>r.conversion_id)).size,1);assert.equal(await funds(p.id,'COINS'),3000n*UNIT);
  assert.equal(await funds(p.id,'USDT'),5n*UNIT);
  await assert.rejects(convert(p.id,randomUUID(),q.id),/already been/);
  const next=await quoteConversion(p.id,'USDT','crypto_to_coins','1');await assert.rejects(convert(p.id,key,next.id),/different conversion/);
  assert.equal((await query('select count(*) from wallet_conversions where user_id=$1',[p.id])).rows[0].count,'1');
});

test('competing conversions cannot overdraw the same crypto or coin balance',async()=>{
  for(const direction of ['crypto_to_coins','coins_to_crypto'] as const){
    const p=await player(direction==='crypto_to_coins'?10n*UNIT:0n,direction==='coins_to_crypto'?6000n*UNIT:0n),amount=direction==='crypto_to_coins'?'10':'6000';
    const [a,b]=await Promise.all([quoteConversion(p.id,'USDT',direction,amount),quoteConversion(p.id,'USDT',direction,amount)]);
    const outcomes=await Promise.allSettled([convert(p.id,randomUUID(),a.id),convert(p.id,randomUUID(),b.id)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(await funds(p.id,direction==='crypto_to_coins'?'USDT':'COINS'),0n);
    assert.equal(await funds(p.id,direction==='crypto_to_coins'?'COINS':'USDT'),(direction==='crypto_to_coins'?6000n:10n)*UNIT);
  }
});

test('a conversion racing a coin wager or crypto withdrawal cannot spend the same source twice',async()=>{
  const p=await player(0n,6000n*UNIT),q=await quoteConversion(p.id,'USDT','coins_to_crypto','6000');
  const race=await Promise.allSettled([convert(p.id,randomUUID(),q.id),startMines(p.id,'COINS','6000',25,3)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(await funds(p.id,'COINS'),0n);
  const other=await player(),quote=await quoteConversion(other.id,'USDT','crypto_to_coins','10');
  const results=await Promise.allSettled([
    convert(other.id,randomUUID(),quote.id).then(()=>true),
    send(other.cookie,'/api/me/withdrawals',{request:randomUUID(),route:'USDT.ERC20',amount:'10',destination:'0x'+'1a'.repeat(20)}).then(r=>r.statusCode===200)
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value).length,1);assert.equal(await funds(other.id,'USDT'),0n);
});

test('expired, foreign, tampered and tiny quotes never move funds; quote prices are immutable',async()=>{
  const p=await player(),other=await player(),q=await quoteConversion(p.id,'USDT','crypto_to_coins','1');
  assert.equal((await send(other.cookie,'/api/me/conversions',{request:randomUUID(),quote:q.id})).statusCode,409);
  assert.equal((await send(p.cookie,'/api/me/conversions/quote',{asset:'USDT',direction:'crypto_to_coins',amount:'1',coin_amount:'999999'})).statusCode,400);
  assert.equal((await send(p.cookie,'/api/me/conversions',{request:randomUUID(),quote:q.id,rate:'9999'})).statusCode,400);
  await assert.rejects(query('update conversion_quotes set coin_amount=coin_amount+1 where id=$1',[q.id]),(e:{code?:string})=>e.code==='23514');
  const expired=(await query(`insert into conversion_quotes(user_id,asset_id,direction,input_amount,crypto_amount,coin_amount,rate_num,rate_den,created_at,expires_at)
    values($1,'USDT','crypto_to_coins',1,1,600,600,1,clock_timestamp()-interval '31 seconds',clock_timestamp()-interval '2 seconds') returning id`,[p.id])).rows[0];
  await assert.rejects(convert(p.id,randomUUID(),expired.id),/expired/);
  const small=await player(0n,1n);await assert.rejects(quoteConversion(small.id,'USDT','coins_to_crypto','0.000000000000000001'),/too small/);
  assert.equal(await funds(p.id,'USDT'),10n*UNIT);assert.equal(await funds(p.id,'COINS'),0n);
  assert.equal((await app.inject({url:'/api/me/conversions',headers:{cookie:other.cookie}})).json().rows.length,0);
});

test('crypto cannot enter any paid game; the DB also fences an old replica',async()=>{
  const p=await player(100n*UNIT),q=await currentQuote('COINS');
  await assert.rejects(startMines(p.id,'USDT','1',25,3),/Unknown currency/);
  for(const [url,payload] of [
    ['/api/games/mines/start',{asset:'ETH',bet:'1',size:25,mines:3}],
    ['/api/games/blackjack/start',{asset:'USDT',bet:'1',request:randomUUID()}],
    ['/api/games/instant',{asset:'USDT',quote:q.id,request:randomUUID(),game:'cases',case:'peppermint'}],
    ['/api/games/battles',{asset:'USDT',quote:q.id,request:randomUUID(),cases:['peppermint'],mode:'1v1',borrow:0,crazy:false,jackpot:false}]
  ] as const)assert.equal((await send(p.cookie,url,payload)).statusCode,400,url);
  await assert.rejects(tx(c=>post(c,'bet:old-replica',randomUUID(),[{account:'u:'+p.id,asset:'USDT',delta:-UNIT},{account:'house:bank',asset:'USDT',delta:UNIT}])),/require coins/);
  assert.equal(await funds(p.id,'USDT'),100n*UNIT);
});

test('a market outage stops native conversion but never fixed-rate USDT conversion or coin games',async()=>{
  const p=await player();offline=true;await expireMarket('ETH');
  try{
    const q=await quoteConversion(p.id,'USDT','crypto_to_coins','10');await convert(p.id,randomUUID(),q.id);
    await assert.rejects(quoteConversion(p.id,'ETH','coins_to_crypto','600'),/Market price/);
    const round=await startMines(p.id,'COINS','100',25,3),secret=(await query('select mine_positions from mines_rounds where id=$1',[round.id])).rows[0];
    await revealMines(p.id,secret.mine_positions[0]);assert.equal(await funds(p.id,'COINS'),5900n*UNIT);
  }finally{offline=false;}
});

test('coins must be converted before crypto withdrawal; reserving and cancelling crypto remain unchanged',async()=>{
  const p=await player(0n,6000n*UNIT),destination='0x'+'1a'.repeat(20);
  const body={request:randomUUID(),route:'USDT.ERC20',amount:'10',destination};
  assert.equal((await send(p.cookie,'/api/me/withdrawals',body)).statusCode,400);
  assert.equal((await send(p.cookie,'/api/me/withdrawals',{...body,route:'COINS'})).statusCode,400);
  const q=await quoteConversion(p.id,'USDT','coins_to_crypto','6000');await convert(p.id,randomUUID(),q.id);
  const w=await send(p.cookie,'/api/me/withdrawals',body);assert.equal(w.statusCode,200,w.body);
  assert.equal(await funds(p.id,'USDT'),0n);
  assert.equal((await send(p.cookie,'/api/me/withdrawals/'+w.json().id+'/cancel',{})).statusCode,200);
  assert.equal(await funds(p.id,'USDT'),10n*UNIT);assert.equal(await funds(p.id,'COINS'),0n);
});

test('already paid crypto rounds finish in their original denomination without adding crypto exposure',async()=>{
  const p=await player(0n);
  const m=(await query(`insert into mines_rounds(user_id,asset_id,bet,size,mines,mine_positions,revealed,server_seed,server_seed_hash,client_seed,nonce)
    values($1,'USDT',1000000000000000000,25,3,'{1,2,3}','{0}','legacy','hash','client',0) returning id`,[p.id])).rows[0];
  await cashoutMines(p.id,m.id);assert.equal(await funds(p.id,'USDT'),minesPayout(UNIT,1,3,25));assert.equal(await funds(p.id,'COINS'),0n);
  const id=randomUUID();await query(`insert into blackjack_rounds(id,user_id,request_id,asset_id,bet,shoe,state,status,server_seed,server_seed_hash,client_seed,nonce)
    values($1,$2,$3,'USDT.ERC20',1000000,'{4,9,5,7,9}',$4,'playing','legacy','hash','client',0)`,
    [id,p.id,randomUUID(),{dealer:[9,7],hands:[{cards:[4,5],bet:'1000000'}],pos:4,active:0,insurance:'0',payout:'0'}]);
  await assert.rejects(actBlackjack(p.id,id,0,'double'),/New wagers use coins/);
  assert.equal((await actBlackjack(p.id,id,0,'stand')).status,'done');
  const legacy=randomUUID();await query(`insert into battles(id,creator,request,asset_id,unit,cost,mode,case_ids,seats,crazy,jackpot,borrow,pf_seed,pf_hash)
    values($1,$2,$3,'USDT',1000000000000000,1000,'1v1','{peppermint}',$4,false,false,'{0,0}','legacy','hash')`,[legacy,p.id,randomUUID(),[p.id,null]]);
  const owned=(await app.inject({url:'/api/me/battles/COINS',headers:{cookie:p.cookie}})).json().battles;
  assert.ok(owned.some((b:any)=>b.id===legacy&&b.asset_id==='USDT'));
  const other=await player();await assert.rejects(battleAction(other.id,legacy,'join',1,0,'COINS'),/Cannot join/);
  const before=await funds(p.id,'USDT');await battleAction(p.id,legacy,'cancel',null,0);assert.equal(await funds(p.id,'USDT'),before+UNIT);
});

test('Mines progress unlocks a daily pack; claims pay coins once and enforce the 24-hour cooldown',async()=>{
  const xp=BigInt((await query('select xp from levels where level=10')).rows[0].xp),p=await player(0n,(xp+1000n)*UNIT);
  const quote=(await currentQuote('COINS')).id,request=randomUUID();
  await assert.rejects(instantRound(p.id,'COINS',quote,request,{game:'rewards',level:10}),/level/);
  const m=await startMines(p.id,'COINS',xp.toString(),25,3),positions=(await query('select mine_positions from mines_rounds where id=$1',[m.id])).rows[0].mine_positions;
  await revealMines(p.id,positions[0]);
  const before=await funds(p.id,'COINS'),result=await instantRound(p.id,'COINS',quote,request,{game:'rewards',level:10});
  assert.deepEqual(await instantRound(p.id,'COINS',quote,request,{game:'rewards',level:10}),result);
  assert.equal(result.asset_id,'COINS');assert.equal(await funds(p.id,'COINS'),before+BigInt(result.payout));
  await assert.rejects(instantRound(p.id,'COINS',quote,randomUUID(),{game:'rewards',level:10}),/next reward/);
  assert.equal((await query("select count(*) from coin_settlements where user_id=$1 and game='rewards'",[p.id])).rows[0].count,'0');
});

test('cancelled battle entries do not rank; a closed season pays its fixed prizes once across replicas',async()=>{
  const p=await player(0n,20000n*UNIT),q=await currentQuote('COINS');
  const b=await createBattle(p.id,{asset:'COINS',quote:q.id,request:randomUUID(),mode:'1v1',cases:['peppermint'],crazy:false,jackpot:false,borrow:0});
  await battleAction(p.id,b.id,'cancel',null,0);assert.ok(!(await coinLeaderboard(p.id)).top.some((r:any)=>r.user_id===p.id));
  const m=await startMines(p.id,'COINS','500',25,3);await revealMines(p.id,(await query('select mine_positions from mines_rounds where id=$1',[m.id])).rows[0].mine_positions[0]);
  const before=await funds(p.id,'COINS');
  const week=(await query("select date_trunc('week',clock_timestamp() at time zone 'UTC') at time zone 'UTC'-interval '7 days' as starts_at")).rows[0].starts_at;
  await query("update coin_settlements set settled_at=$2::timestamptz+interval '1 day' where user_id=$1",[p.id,week]);
  await query("insert into coin_seasons(starts_at,ends_at) values($1,$1::timestamptz+interval '7 days') on conflict do nothing",[week]);
  await Promise.all([settleCoinSeasons(),settleCoinSeasons()]);await settleCoinSeasons();
  assert.equal(await funds(p.id,'COINS'),before+WEEKLY_PRIZES[0]!);
  assert.equal((await query('select count(*) from coin_season_payouts where starts_at=$1 and user_id=$2',[week,p.id])).rows[0].count,'1');
  const standing=await coinLeaderboard(p.id);assert.ok(standing.last_week.some((r:any)=>r.user_id===p.id&&r.prize===WEEKLY_PRIZES[0]!.toString()));
  assert.equal(standing.prize_pool,(500000n*UNIT).toString());
});
