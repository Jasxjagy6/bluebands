// Integration test for the money ledger against a real Postgres.
// Requires DATABASE_URL (the migrated treasury DB). Run via run-int.ts which
// sets the env. Verifies: deposit credit, bet debit, payout, no overdraft,
// double-entry balance, and concurrency safety (no double-spend).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, tx, query } from '../db.js';
import { post, balanceOf, getUserBalances } from '../ledger.js';
import { debitStake, creditPayout, InsufficientFunds } from '../bet.js';
import { installMarketFixture } from './market-fixture.js';

installMarketFixture();
const ASSET = 'COINS';
let uid: string;

test('setup: make a throwaway user', async () => {
  const r = await query<{ id: string }>(
    `insert into users(email, username, pass_hash) values ($1,$2,'x') returning id`,
    [`t_${crypto.randomUUID()}@test.local`, 't' + crypto.randomBytes(4).toString('hex')],
  );
  uid = r.rows[0]!.id;
});

test('deposit credit increases balance (double-entry)', async () => {
  await tx((c) => post(c, 'deposit', 'test', [
    { account: `ext:ETH`, asset: ASSET, delta: -1_000_000n },
    { account: `u:${uid}`, asset: ASSET, delta: 1_000_000n },
  ]));
  const bals = await getUserBalances(uid);
  assert.equal(bals.find((b) => b.asset_id === ASSET)?.amount, '1000000');
});

test('bet debits, payout credits, house keeps the edge', async () => {
  await tx((c) => debitStake(c, uid, ASSET, 400_000n, 'dice', 'r1'));
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '600000');
  // win pays 1.5x the 400000 stake
  await tx((c) => creditPayout(c, uid, ASSET, 600_000n, 'dice', 'r1'));
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '1200000');
});

test('cannot overdraw (DB CHECK + locked read both block it)', async () => {
  await assert.rejects(
    () => tx((c) => debitStake(c, uid, ASSET, 999_999_999n, 'dice', 'r2')),
    (e: Error) => e instanceof InsufficientFunds,
  );
  // balance unchanged
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '1200000');
});

test('concurrent bets cannot double-spend', async () => {
  // balance is 1_200_000; fire two 800_000 bets at once — exactly one wins
  const results = await Promise.allSettled([
    tx((c) => debitStake(c, uid, ASSET, 800_000n, 'dice', 'c1')),
    tx((c) => debitStake(c, uid, ASSET, 800_000n, 'dice', 'c2')),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, 'exactly one of two racing bets should succeed');
  assert.equal((await tx((c) => balanceOf(c, `u:${uid}`, ASSET))).toString(), '400000');
});

test('cleanup', async () => {
  await query(`delete from users where id=$1`, [uid]);
  await pool.end();
});
