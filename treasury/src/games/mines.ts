import { lockActivePlayer } from '../auth-user.js';
import type { PoolClient } from 'pg';
import { pool, query, tx } from '../db.js';
import { parseAmount } from '../money.js';
import { shuffle } from '../fair.js';
import { takeGameSeed } from '../game-seeds.js';
import { debitStake, creditPayout } from '../bet.js';

const SIZES = new Set([16, 25, 36, 49, 64]);
const EDGE_NUM = 95n, EDGE_DEN = 100n; // 5% house edge, matching the original

// ---- pure math (exact rational, floor; verifiable) ----
// multiplier(k) = 0.95 * Π_{i=0}^{k-1} (n-i)/(n-m-i)
export function minesRatio(k: number, m: number, n: number): { num: bigint; den: bigint } {
  if (k <= 0) return { num: 1n, den: 1n };
  let num = EDGE_NUM, den = EDGE_DEN;
  for (let i = 0; i < k; i++) { num *= BigInt(n - i); den *= BigInt(n - m - i); }
  return { num, den };
}
export function minesPayout(bet: bigint, k: number, m: number, n: number): bigint {
  const { num, den } = minesRatio(k, m, n);
  return (bet * num) / den;
}
export function minesMultiplierStr(k: number, m: number, n: number, dp = 4): string {
  const { num, den } = minesRatio(k, m, n);
  const scaled = (num * 10n ** BigInt(dp)) / den;
  const s = scaled.toString().padStart(dp + 1, '0');
  return s.slice(0, -dp) + '.' + s.slice(-dp);
}

type Row = {
  id: string; user_id: string; asset_id: string; bet: string; size: number; mines: number;
  mine_positions: number[]; revealed: number[]; status: string; payout: string;
  server_seed: string; server_seed_hash: string; client_seed: string; nonce: string;
};

function view(g: Row, revealMines: boolean) {
  const k = g.revealed.length;
  const cleared = g.size - g.mines;
  return {
    id: g.id, asset_id: g.asset_id, bet: g.bet, size: g.size, mines: g.mines,
    revealed: g.revealed, status: g.status, payout: g.payout,
    multiplier: minesMultiplierStr(k, g.mines, g.size),
    next_multiplier: k < cleared ? minesMultiplierStr(k + 1, g.mines, g.size) : null,
    server_seed_hash: g.server_seed_hash, client_seed: g.client_seed, nonce: Number(g.nonce),
    ...(revealMines ? { mine_positions: g.mine_positions, server_seed: g.server_seed } : {}),
  };
}

export async function assetDecimals(assetId: string,db:Pick<PoolClient,'query'>=pool): Promise<number> {
  const r = await db.query<{ decimals: number }>('select decimals from playing_assets where id=$1', [assetId]);
  if (!r.rows[0]) throw new Error('Unknown currency');
  return r.rows[0].decimals;
}

export async function startMines(userId: string, assetId: string, betHuman: string, size: number, mines: number, request?:string) {
  if (!SIZES.has(size)) throw new Error('Pick a grid size');
  if (!Number.isInteger(mines) || mines < 1 || mines > size - 1) throw new Error(`Pick between 1 and ${size - 1} mines`);
  return tx(async (c) => {
    await lockActivePlayer(c,userId);
    if (request) {
      const prior=(await c.query<Row>('select * from mines_rounds where user_id=$1 and request_id=$2',[userId,request])).rows[0];
      if(prior) return view(prior,prior.status!=='active');
    }
    const bet=parseAmount(betHuman,await assetDecimals(assetId,c));
    if(bet<=0n)throw new Error('Enter a bet amount');
    const act = await c.query(`select 1 from mines_rounds where user_id=$1 and status='active'`, [userId]);
    if (act.rows[0]) throw new Error('Finish your current game first');

    const f = await takeGameSeed(c, userId);
    const nonce = Number(f.nonce);
    const perm = shuffle(size, f.server_seed, f.client_seed, nonce);
    const minePos = perm.slice(0, mines).sort((a, b) => a - b);

    const r = await c.query<Row>(
      `insert into mines_rounds(user_id, asset_id, bet, size, mines, mine_positions, server_seed, server_seed_hash, client_seed, nonce, request_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [userId, assetId, bet.toString(), size, mines, minePos, f.server_seed, f.server_seed_hash, f.client_seed, nonce, request??null],
    );
    await debitStake(c,userId,assetId,bet,'mines',r.rows[0]!.id);
    return view(r.rows[0]!, false);
  });
}

export async function revealMines(userId: string, tile: number, roundId?:string) {
  return tx(async (c) => {
    await lockActivePlayer(c,userId);
    const g = (await c.query<Row>(`select * from mines_rounds where user_id=$1 and status='active' and ($2::bigint is null or id=$2) for update`, [userId,roundId??null])).rows[0];
    if (!g) throw new Error('No active game');
    if (!Number.isInteger(tile) || tile < 0 || tile >= g.size) throw new Error('Bad tile');
    if (g.revealed.includes(tile)) return { result: 'gem', ...view(g, false) };

    if (g.mine_positions.includes(tile)) {
      const r = (await c.query<Row>(`update mines_rounds set status='lost', ended_at=now() where id=$1 returning *`, [g.id])).rows[0]!;
      return { result: 'mine', tile, ...view(r, true) };
    }

    const revealed = [...g.revealed, tile];
    const k = revealed.length;
    if (k === g.size - g.mines) {
      const pay = minesPayout(BigInt(g.bet), k, g.mines, g.size);
      const r = (await c.query<Row>(`update mines_rounds set revealed=$2, status='cashed', payout=$3, ended_at=now() where id=$1 returning *`, [g.id, revealed, pay.toString()])).rows[0]!;
      await creditPayout(c, userId, g.asset_id, pay, 'mines', `mines:${g.id}`);
      return { result: 'cashed', ...view(r, true) };
    }
    const r = (await c.query<Row>(`update mines_rounds set revealed=$2 where id=$1 returning *`, [g.id, revealed])).rows[0]!;
    return { result: 'gem', ...view(r, false) };
  });
}

export async function cashoutMines(userId: string, roundId?:string) {
  return tx(async (c) => {
    await lockActivePlayer(c,userId);
    const g = (await c.query<Row>(`select * from mines_rounds where user_id=$1 and status='active' and ($2::bigint is null or id=$2) for update`, [userId,roundId??null])).rows[0];
    if (!g) throw new Error('No active game');
    const k = g.revealed.length;
    if (k === 0) throw new Error('Pick a tile first');
    const pay = minesPayout(BigInt(g.bet), k, g.mines, g.size);
    const r = (await c.query<Row>(`update mines_rounds set status='cashed', payout=$2, ended_at=now() where id=$1 returning *`, [g.id, pay.toString()])).rows[0]!;
    await creditPayout(c, userId, g.asset_id, pay, 'mines', `mines:${g.id}`);
    return { result: 'cashed', ...view(r, true) };
  });
}

export async function activeMines(userId: string) {
  const g = (await query<Row>(`select * from mines_rounds where user_id=$1 and status='active'`, [userId])).rows[0];
  return g ? view(g, false) : null;
}
