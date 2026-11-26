import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, applyMultiplier } from '../money.js';

test('parseAmount: whole and fractional', () => {
  assert.equal(parseAmount('1', 6), 1_000_000n);
  assert.equal(parseAmount('1.5', 6), 1_500_000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.equal(parseAmount('1', 18), 1_000_000_000_000_000_000n);
});

test('parseAmount: rejects garbage and over-precision', () => {
  assert.throws(() => parseAmount('abc', 6));
  assert.throws(() => parseAmount('1.2.3', 6));
  assert.throws(() => parseAmount('0.0000001', 6)); // 7dp into a 6dp asset
});

test('formatAmount: round-trips and trims zeros', () => {
  assert.equal(formatAmount(1_500_000n, 6), '1.5');
  assert.equal(formatAmount(1_000_000n, 6), '1');
  assert.equal(formatAmount(1n, 6), '0.000001');
  assert.equal(formatAmount(-2_500_000n, 6), '-2.5');
});

test('applyMultiplier: floors, never rounds up (house-safe)', () => {
  assert.equal(applyMultiplier(1_000_000n, '1.98'), 1_980_000n);
  assert.equal(applyMultiplier(1_000_000n, '0.5'), 500_000n);
  assert.equal(applyMultiplier(3n, '1.5'), 4n);        // 4.5 -> floor 4
  assert.equal(applyMultiplier(1n, '0.99'), 0n);        // 0.99 -> floor 0
  assert.equal(applyMultiplier(1_000_000n, '2'), 2_000_000n);
});

test('applyMultiplier: rejects bad input', () => {
  assert.throws(() => applyMultiplier(100n, 'x'));
  assert.throws(() => applyMultiplier(-1n, '2'));
});
