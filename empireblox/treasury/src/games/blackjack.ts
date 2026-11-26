import { lockActivePlayer } from '../auth-user.js';
import { randomUUID } from 'node:crypto';
import { query, tx } from '../db.js';
import { parseAmount } from '../money.js';
import { shuffle } from '../fair.js';
import { takeGameSeed } from '../game-seeds.js';
import { debitStake, creditPayout } from '../bet.js';
import { assetDecimals } from './mines.js';

export type Action = 'hit' | 'stand' | 'double' | 'split' | 'insure' | 'no_insure';
type Result = 'win' | 'lose' | 'blackjack' | 'push' | 'bust';
type Hand = { cards: number[]; bet: string; result?: Result };
type State = { dealer: number[]; hands: Hand[]; pos: number; active: number; insurance: string; payout: string };
type Round = { id:string; asset_id:string; bet:string; shoe:number[]; state:State; status:'insurance'|'playing'|'done';
  version:number; server_seed:string; server_seed_hash:string; client_seed:string; nonce:string };

export function total(cards: number[]): number {
  let points = 0, aces = 0;
  for (const card of cards) {
    const rank = card % 13;
    if (!rank) aces++;
    points += rank ? Math.min(10, rank + 1) : 11;
  }
  while (points > 21 && aces > 0) { points -= 10; aces--; }
  return points;
}
const natural = (cards: number[]) => cards.length === 2 && total(cards) === 21;
const canSplit = (g: Round) => {
  const cards = g.state.hands[0]!.cards;
  return g.status === 'playing' && g.state.hands.length === 1 && cards.length === 2 && cards[0]! % 13 === cards[1]! % 13;
};
function draw(g: Round) { return g.shoe[g.state.pos++]!; }

function finish(g: Round) {
  const s = g.state;
  if (s.hands.some(h => total(h.cards) <= 21) && !(s.hands.length === 1 && natural(s.hands[0]!.cards))) {
    while (total(s.dealer) < 17) s.dealer.push(draw(g));
  }
  const dealer = total(s.dealer), dealerNatural = natural(s.dealer);
  let payout = dealerNatural ? 3n * BigInt(s.insurance) : 0n;
  for (const h of s.hands) {
    const player = total(h.cards), bet = BigInt(h.bet);
    if (player > 21) h.result = 'bust';
    else if (s.hands.length === 1 && natural(h.cards) && !dealerNatural) { h.result = 'blackjack'; payout += bet * 5n / 2n; }
    else if (dealerNatural && !(s.hands.length === 1 && natural(h.cards))) h.result = 'lose';
    else if (dealer > 21 || player > dealer) { h.result = 'win'; payout += bet * 2n; }
    else if (player === dealer) { h.result = 'push'; payout += bet; }
    else h.result = 'lose';
  }
  g.status = 'done'; s.payout = payout.toString();
}
function advance(g: Round) {
  if (g.state.active + 1 < g.state.hands.length && total(g.state.hands[g.state.active + 1]!.cards) < 21) g.state.active++;
  else finish(g);
}
function play(g: Round, action: Action): bigint {
  const s = g.state, h = s.hands[s.active]!, bet = BigInt(g.bet);
  if (g.status === 'insurance') {
    if (action !== 'insure' && action !== 'no_insure') throw new Error('Choose whether to insure');
    const extra = action === 'insure' ? bet / 2n : 0n;
    if (action === 'insure' && !extra) throw new Error('Bet is too small to insure');
    s.insurance = extra.toString(); g.status = 'playing';
    if (natural(s.dealer) || natural(h.cards)) finish(g);
    return extra;
  }
  if (action === 'stand') advance(g);
  else if (action === 'hit') { h.cards.push(draw(g)); if (total(h.cards) >= 21) advance(g); }
  else if (action === 'double') {
    if (h.cards.length !== 2) throw new Error('Double on your first two cards');
    h.bet = (2n * bet).toString(); h.cards.push(draw(g)); advance(g); return bet;
  } else if (action === 'split') {
    if (!canSplit(g)) throw new Error('Split requires a matching pair');
    const second = h.cards.pop()!;
    h.cards.push(draw(g)); s.hands.push({ cards: [second, draw(g)], bet:g.bet });
    if (second % 13 === 0) finish(g);
    else if (total(h.cards) === 21) advance(g);
    return bet;
  } else throw new Error('Action unavailable');
  return 0n;
}
function view(g: Round) {
  const s = g.state, ended = g.status === 'done';
  return { id:g.id, asset_id:g.asset_id, bet:g.bet, status:g.status, version:g.version, active:s.active + 1,
    hands:s.hands, dealer:ended ? s.dealer : [s.dealer[0], -1], insurance:s.insurance, payout:s.payout,
    can_split:canSplit(g), can_double:g.status === 'playing' && s.hands[s.active]!.cards.length === 2,
    server_seed_hash:g.server_seed_hash, client_seed:g.client_seed, nonce:Number(g.nonce),
    ...(ended ? { server_seed:g.server_seed } : {}) };
}
export async function startBlackjack(uid: string, asset: string, amount: string, request: string) {
  return tx(async c => {
    await lockActivePlayer(c,uid);
    const existing = (await c.query<Round>('select * from blackjack_rounds where user_id=$1 and request_id=$2', [uid, request])).rows[0];
    if (existing) return view(existing);
    const bet=parseAmount(amount,await assetDecimals(asset,c));
    if(bet<=0n)throw new Error('Enter a bet amount');
    const active = await c.query("select 1 from blackjack_rounds where user_id=$1 and status<>'done'", [uid]);
    if (active.rowCount) throw new Error('Finish your current hand first');
    const f = await takeGameSeed(c, uid);
    const shoe = shuffle(312, f.server_seed, f.client_seed, Number(f.nonce)).map(card => card % 52);
    const g: Round = { ...f, id:randomUUID(), asset_id:asset, bet:bet.toString(), shoe, version:0, status:'playing',
      state:{ dealer:[shoe[1]!, shoe[3]!], hands:[{ cards:[shoe[0]!, shoe[2]!], bet:bet.toString() }],
        pos:4, active:0, insurance:'0', payout:'0' } };
    const booked=await debitStake(c, uid, asset, bet, 'blackjack', g.id);
    if (shoe[1]! % 13 === 0) g.status = 'insurance';
    else if (natural(g.state.dealer) || natural(g.state.hands[0]!.cards)) finish(g);
    await c.query(`insert into blackjack_rounds(id,user_id,request_id,asset_id,bet,shoe,state,status,server_seed,server_seed_hash,client_seed,nonce,minor_per_usd)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [g.id,uid,request,asset,g.bet,shoe,g.state,g.status,f.server_seed,f.server_seed_hash,f.client_seed,f.nonce,booked.minor_per_usd]);
    if (g.status === 'done') await creditPayout(c, uid, asset, BigInt(g.state.payout), 'blackjack', g.id);
    return view(g);
  });
}
export async function actBlackjack(uid:string, id:string, version:number, action:Action) {
  return tx(async c => {
    await lockActivePlayer(c,uid);
    const g = (await c.query<Round>('select * from blackjack_rounds where user_id=$1 and id=$2 for update', [uid,id])).rows[0];
    if (!g) throw new Error('Hand unavailable');
    if (g.version !== version || g.status === 'done') return view(g);
    const previous=g.state.hands.reduce((n,h)=>n+BigInt(h.bet),BigInt(g.state.insurance));
    const extra = play(g, action);
    if (extra) await debitStake(c, uid, g.asset_id, extra, 'blackjack', g.id,{previous});
    if ((g.status as Round['status']) === 'done') await creditPayout(c, uid, g.asset_id, BigInt(g.state.payout), 'blackjack', g.id);
    g.version++;
    await c.query('update blackjack_rounds set state=$2,status=$3,version=$4 where id=$1', [g.id,g.state,g.status,g.version]);
    return view(g);
  });
}
export async function activeBlackjack(uid:string) {
  const g = (await query<Round>("select * from blackjack_rounds where user_id=$1 and status<>'done'", [uid])).rows[0];
  return g ? view(g) : null;
}
