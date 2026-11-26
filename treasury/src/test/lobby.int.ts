import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { pool,query,tx } from '../db.js';
import { post,balanceOf } from '../ledger.js';
import { currentQuote,quoteUnit,instantRound } from '../games/catalog.js';
import { createBattle,battleAction,listBattles } from '../games/battles.js';
import { buildServer } from '../api/server.js';
import { createSession } from '../auth-user.js';
import { hashPassword, verifyTotp } from '../authutil.js';
import { startMines, revealMines } from '../games/mines.js';
import { installMarketFixture,expireMarket } from './market-fixture.js';

installMarketFixture();
const u=randomUUID(),v=randomUUID(),asset='USDT',unit=quoteUnit('1',18),app=await buildServer();
let quote='',cookie='';
const balance=(uid:string)=>tx(c=>balanceOf(c,'u:'+uid,asset));
const priced=()=>({asset,quote,request:randomUUID()});
before(async()=>{
  for(const uid of [u,v]){
    await query("insert into users(id,username,email,pass_hash) values($1,$2,$3,'x')",[uid,'t'+randomBytes(4).toString('hex'),uid+'@test.invalid']);
    await tx(c=>post(c,'deposit','lobby-test',[{account:'ext:ETH',asset,delta:-1000000n*unit},{account:'u:'+uid,asset,delta:1000000n*unit}]));
  }
  await expireMarket(asset);quote=(await currentQuote(asset)).id;
  cookie='eb_sess='+await createSession(u);
});
after(async()=>{await app.close();await pool.end();});
test('prices preserve precision and expire before a charge',async()=>{
  assert.equal(quoteUnit('0.000600000000000000',18),1000000000000n);
  assert.throws(()=>quoteUnit('invalid',6));
  const expired=(await query("insert into game_quotes(asset_id,unit,expires_at) values($1,1,now()-interval '2 seconds') returning id",[asset])).rows[0].id;
  const b=await balance(u);
  await assert.rejects(instantRound(u,asset,expired,randomUUID(),{game:'cases',case:'peppermint'}),/expired/);
  await assert.rejects(instantRound(u,'ETH',quote,randomUUID(),{game:'cases',case:'peppermint'}),/expired/);
  assert.equal(await balance(u),b);
});
test('case and upgrader settle in the quoted asset and support safe retries',async()=>{
  for(const action of [{game:'cases',case:'peppermint'} as const,{game:'upgrader',item:21070012,bet:'0.00000000000001',over:true} as const]){
    const k=randomUUID(),before=await balance(u);
    const [a,b]=await Promise.all([instantRound(u,asset,quote,k,action),instantRound(u,asset,quote,k,action)]);
    assert.deepEqual(a,b);
    assert.equal(await balance(u),before-BigInt(a.stake)+BigInt(a.payout));
    assert.equal((await query("select count(*) from journals where kind like 'bet:%' and ref=$1",[k])).rows[0].count,'1');
  }
});
test('battles lock prices, isolate seats and refund each purchased share only once',async()=>{
  const start=await balance(u), second=await balance(v);
  const b={...priced(),mode:'3way',cases:['peppermint'],crazy:false,jackpot:false,borrow:20};
  const {id}=await createBattle(u,b); assert.equal((await createBattle(u,b)).id,id);
  await assert.rejects(battleAction(v,id,'bots',null,0));
  await assert.rejects(battleAction(v,id,'join',1,0,'BNB'));
  await battleAction(v,id,'join',1,50,asset);
  const row=(await listBattles(asset,u)).find(x=>x.id===id);
  assert.equal(row.pf_seed,null);assert.equal(row.unit,unit.toString());
  assert.equal(start-await balance(u),800n*unit); assert.equal(second-await balance(v),500n*unit);
  await battleAction(u,id,'cancel',null,0);
  await assert.rejects(battleAction(u,id,'cancel',null,0));
  assert.equal(await balance(u),start);assert.equal(await balance(v),second);
});
test('final seat settles a group, team, crazy and jackpot battle at most once',async()=>{
  for(const [mode,crazy,jackpot] of [['g3',false,false],['2v2',false,false],['3way',true,true]] as const){
    const {id}=await createBattle(u,{...priced(),mode,crazy,jackpot,cases:['peppermint','faberge'],borrow:0});
    await battleAction(v,id,'join',1,20,asset);
    const result=await Promise.allSettled([battleAction(u,id,'bots',null,0),battleAction(u,id,'bots',null,0)]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
    const b=(await listBattles(asset,u)).find(x=>x.id===id);
    assert.equal(b.status,'rolling'); assert.equal(b.pf_seed.length,64);assert.equal(b.results[0].length,2);
    const won=(await query("select coalesce(sum(e.delta),0)::text as paid from journals j join ledger_entries e on e.journal_id=j.id where j.ref=$1 and j.kind='payout:battles' and e.account like 'u:%'",[id])).rows[0].paid;
    assert.equal(BigInt(won),BigInt(b.payouts[0]+b.payouts[1])*unit);
  }
});
test('reward claims are earned per catalog wager and have a server-enforced cooldown',async()=>{
  const claim=()=>instantRound(u,asset,quote,randomUUID(),{game:'rewards',level:10});
  await assert.rejects(claim(),/level/);
  await query('update users set catalog_wagered=(select xp from levels where level=10) where id=$1',[u]);
  const results=await Promise.allSettled([claim(),claim()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('chat, public profile, weekly ranking and session isolation',async()=>{
  const chat=()=>app.inject({method:'POST',url:'/api/chat',headers:{cookie},payload:{body:'Hello from test'}});
  assert.equal((await chat()).statusCode,200);assert.equal((await chat()).statusCode,400);
  const messages=(await app.inject('/api/chat')).json().messages;
  assert.ok(messages.some((m:any)=>m.user_id===u && m.body==='Hello from test'));
  const profile=(await app.inject('/api/players/'+u)).json();
  assert.equal(profile.email,undefined);assert.equal(profile.pass_hash,undefined);
  const rank=(await app.inject('/api/leaderboard/'+asset)).json();
  assert.ok(rank.top.some((r:any)=>r.user_id===u));
  const peer=await app.inject({method:'POST',url:'/api/chat',headers:{cookie,origin:'https://unrelated.invalid'},payload:{body:'hi'}});
  assert.equal(peer.statusCode,403);
  await query('update users set disabled=true where id=$1',[u]);
  assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie}})).statusCode,401);
  await query('update users set disabled=false where id=$1',[u]);
});
test('mines start replay and stale round IDs cannot charge or reveal another round',async()=>{
  const b=await balance(u),key=randomUUID();
  const a=await startMines(u,asset,'0.0000000000001',25,3,key), again=await startMines(u,asset,'0.0000000000001',25,3,key);
  assert.deepEqual(again,a);assert.equal(await balance(u),b-100000n);
  await assert.rejects(revealMines(u,0,'999999999'),/No active/);
});
test('admin sessions revoke on logout and the watch-only vault refuses signing keys',async()=>{
  const login='admin-'+randomBytes(4).toString('hex'),password=randomUUID();
  await query('insert into admin_users(username,pass_hash) values($1,$2)',[login,hashPassword(password)]);
  const res=await app.inject({method:'POST',url:'/api/admin/login',payload:{username:login,password}});
  assert.equal(res.statusCode,200);const headers={cookie:String(res.headers['set-cookie']).split(';')[0]};
  assert.equal((await app.inject({method:'PUT',url:'/api/admin/secrets',headers,payload:{name:'xpub:ETH',value:'invalid extended key'}})).statusCode,400);
  assert.equal(verifyTotp('AAAAAAAA','1234567'),false);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/logout',headers})).statusCode,200);
  assert.equal((await app.inject({url:'/api/admin/me',headers})).statusCode,401);
});
