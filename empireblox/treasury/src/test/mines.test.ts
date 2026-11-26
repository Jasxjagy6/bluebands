import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minesRatio, minesPayout, minesMultiplierStr } from '../games/mines.js';

test('k=0 is a no-op multiplier', () => {
  assert.deepEqual(minesRatio(0, 3, 25), { num: 1n, den: 1n });
  assert.equal(minesMultiplierStr(0, 3, 25), '1.0000');
  assert.equal(minesPayout(1_000_000n, 0, 3, 25), 1_000_000n);
});

test('known value: n=25, m=3, k=1 => 0.95*25/22', () => {
  // 95*25 / (100*22) = 2375/2200 = 1.079545...
  assert.equal(minesMultiplierStr(1, 3, 25), '1.0795');
  assert.equal(minesPayout(1_000_000n, 1, 3, 25), 1_079_545n); // floored
});

test('multiplier strictly increases with each safe reveal', () => {
  let prev = 0;
  for (let k = 1; k <= 25 - 3; k++) {
    const v = Number(minesMultiplierStr(k, 3, 25));
    assert.ok(v > prev, `k=${k} should exceed previous`);
    prev = v;
  }
});

test('more mines => higher multiplier for same k', () => {
  assert.ok(Number(minesMultiplierStr(1, 10, 25)) > Number(minesMultiplierStr(1, 3, 25)));
});

test('payout always floors (never overpays)', () => {
  // pick a case with a non-integer product
  const p = minesPayout(7n, 2, 5, 16);
  const { num, den } = minesRatio(2, 5, 16);
  assert.equal(p, (7n * num) / den);
  assert.ok(p <= (7n * num) / den);
});
