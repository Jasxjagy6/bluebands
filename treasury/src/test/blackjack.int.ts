import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { query, tx, pool } from '../db.js';
import { post, balanceOf } from '../ledger.js';
import { total, startBlackjack, actBlackjack, activeBlackjack } from '../games/blackjack.js';
import { hashSeed, shuffle } from '../fair.js';
import { installMarketFixture } from './market-fixture.js';

installMarketFixture();
const uid=randomUUID(), asset='USDT', client='blackjack-test';
const balance=()=>tx(c=>balanceOf(c,'u:'+uid,asset));
before(async()=>{
  await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'x')",[uid,uid+'@test.invalid','b'+randomBytes(5).toString('hex')]);
  await tx(c=>post(c,'deposit','fixture',[{account:'ext:ETH',asset,delta:-100n * 10n**18n},{account:'u:'+uid,asset,delta:100n * 10n**18n}]));
});
after(async()=>{await pool.end();});
async function deal(matches:(shoe:number[])=>boolean, bet='1') {
  let seed='', shoe:number[]=[];
  for (let i=0;i<10000;i++) {
    seed='blackjack-'+i; shoe=shuffle(312,seed,client,0).map(c=>c%52);
    if(matches(shoe)) break;
  }
  assert.ok(matches(shoe));
  await query(`insert into user_fair(user_id,server_seed,server_seed_hash,client_seed,nonce) values($1,$2,$3,$4,0)
    on conflict(user_id) do update set server_seed=excluded.server_seed,server_seed_hash=excluded.server_seed_hash,client_seed=excluded.client_seed,nonce=0`,
    [uid,seed,hashSeed(seed),client]);
  const key=randomUUID();
  return {r:await startBlackjack(uid,asset,bet,key),key,shoe,seed};
}
test('ace totals and odd-unit natural blackjack payouts',async()=>{
  assert.equal(total([0,13,6]),19);
  const before=await balance();
  const {r,key}=await deal(s=>total([s[0]!,s[2]!])===21 && s[1]!%13!==0 && total([s[1]!,s[3]!])!==21,'0.000000000000000003');
  assert.equal(r.status,'done'); assert.equal(r.payout,'7');
  assert.equal((await startBlackjack(uid,asset,'0.000000000000000003',key)).id,r.id);
  assert.equal(await balance(),before+4n); assert.equal(await activeBlackjack(uid),null);
});
test('resumes privately, splits a pair, doubles once and settles once on replay',async()=>{
  const before=await balance();
  const {r}=await deal(s=>s[0]!%13===4 && s[2]!%13===4 && s[1]!%13>0 && s[1]!%13<9);
  assert.equal(r.can_split,true); assert.equal(r.dealer[1],-1); assert.equal(r.server_seed,undefined);
  assert.deepEqual(await activeBlackjack(uid),r); assert.equal(await activeBlackjack(randomUUID()),null);
  const split=await actBlackjack(uid,r.id,0,'split'); assert.equal(split.hands.length,2); assert.equal(split.active,1);
  const doubled=await Promise.all([actBlackjack(uid,r.id,1,'double'),actBlackjack(uid,r.id,1,'double')]);
  assert.deepEqual(doubled[0],doubled[1]);
  assert.equal(doubled[0].hands[0]!.bet,'2000000000000000000');
  const done=await actBlackjack(uid,r.id,2,'stand'); assert.equal(done.status,'done');
  assert.equal((await actBlackjack(uid,r.id,2,'stand')).payout,done.payout);
  assert.equal(await balance(),before-3n * 10n**18n+BigInt(done.payout));
});
test('insurance pays 2 to 1 on dealer blackjack, rejects invalid action and isolates owners',async()=>{
  const before=await balance();
  const {r}=await deal(s=>s[1]!%13===0 && s[3]!%13>=9 && total([s[0]!,s[2]!])!==21);
  assert.equal(r.status,'insurance'); await assert.rejects(actBlackjack(uid,r.id,0,'hit'));
  await assert.rejects(actBlackjack(randomUUID(),r.id,0,'stand'));
  assert.equal((await actBlackjack(uid,r.id,0,'insure')).payout,'1500000000000000000');
  assert.equal(await balance(),before); assert.equal(await activeBlackjack(uid),null);
});
test('split aces receive one card each and finish immediately',async()=>{
  const {r}=await deal(s=>s[0]!%13===0 && s[2]!%13===0 && s[1]!%13>0 && s[1]!%13<9);
  const done=await actBlackjack(uid,r.id,0,'split');
  assert.equal(done.status,'done'); assert.ok(done.hands.every(h=>h.cards.length===2));
});
test('insufficient stake leaves the ledger and active hands unchanged',async()=>{
  const before=await balance(); await assert.rejects(startBlackjack(uid,asset,'999999',randomUUID()),/Insufficient/);
  assert.equal(await balance(),before); assert.equal(await activeBlackjack(uid),null);
});
