// Full provably-fair Mines round against a real Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, tx, query } from '../db.js';
import { post, balanceOf } from '../ledger.js';
import { shuffle, hashSeed } from '../fair.js';
import { startMines, revealMines, cashoutMines, activeMines, minesPayout } from '../games/mines.js';
import { installMarketFixture } from './market-fixture.js';

installMarketFixture();
const ASSET = 'COINS';
let uid: string;
const SEED = 'a'.repeat(64), CLIENT = 'client-seed', SIZE = 25, MINES = 3;

test('setup: user with a known fair seed and a balance', async () => {
  uid = (await query<{ id: string }>(
    `insert into users(email, username, pass_hash) values ($1,$2,'x') returning id`,
    [`m_${crypto.randomUUID()}@test.local`, 'm' + crypto.randomBytes(4).toString('hex')],
  )).rows[0]!.id;
  await query(`insert into user_fair(user_id, server_seed, server_seed_hash, client_seed, nonce) values ($1,$2,$3,$4,0)`,
    [uid, SEED, hashSeed(SEED), CLIENT]);
  await tx((c) => post(c, 'deposit', 'seed', [
    { account: 'ext:ETH', asset: ASSET, delta: -5n * 10n**18n },
    { account: `u:${uid}`, asset: ASSET, delta: 5n * 10n**18n },
  ]));
});

test('start debits the stake and hides mine positions', async () => {
  const v: any = await startMines(uid, ASSET, '1', SIZE, MINES);
  assert.equal(v.status, 'active');
  assert.equal(v.mine_positions, undefined, 'positions must not leak while active');
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '4000000000000000000');
});

test('revealing a known-safe tile is a gem; round resumes identically', async () => {
  const perm = shuffle(SIZE, SEED, CLIENT, 0);          // nonce 0 was used by start
  const mines = new Set(perm.slice(0, MINES));
  const safe = [...Array(SIZE).keys()].find((t) => !mines.has(t))!;
  const r: any = await revealMines(uid, safe);
  assert.equal(r.result, 'gem');
  assert.deepEqual(r.revealed, [safe]);
  const resume: any = await activeMines(uid);
  assert.deepEqual(resume.revealed, [safe]);            // resumable state
});

test('revealing a known mine loses the round (stake already taken)', async () => {
  const perm = shuffle(SIZE, SEED, CLIENT, 0);
  const aMine = perm.slice(0, MINES).sort((a, b) => a - b)[0]!;
  const r: any = await revealMines(uid, aMine);
  assert.equal(r.result, 'mine');
  assert.ok(Array.isArray(r.mine_positions));           // revealed on loss
  assert.equal(await activeMines(uid), null);
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '4000000000000000000'); // unchanged (lost stake)
});

test('a fresh round can be cashed out for the correct payout', async () => {
  const {server_seed} = (await query('select server_seed from user_fair where user_id=$1',[uid])).rows[0];
  assert.notEqual(server_seed, SEED);
  await startMines(uid, ASSET, '1', SIZE, MINES);
  const perm = shuffle(SIZE, server_seed, CLIENT, 1);
  const mines = new Set(perm.slice(0, MINES));
  const safe = [...Array(SIZE).keys()].find((t) => !mines.has(t))!;
  await revealMines(uid, safe);
  const before = await tx((c) => balanceOf(c, `u:${uid}`, ASSET));
  const r: any = await cashoutMines(uid);
  const expected = minesPayout(10n**18n, 1, MINES, SIZE);
  assert.equal(r.payout, expected.toString());
  const after = await tx((c) => balanceOf(c, `u:${uid}`, ASSET));
  assert.equal((after - before).toString(), expected.toString());
});

test('cleanup', async () => {
  await query(`delete from users where id=$1`, [uid]);
  await pool.end();
});
