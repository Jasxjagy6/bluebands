import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newServerSeed, hashSeed, floats, shuffle, intBelow } from '../fair.js';

test('hashSeed is sha256 and stable', () => {
  const h = hashSeed('abc');
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('floats are deterministic and in [0,1)', () => {
  const a = floats('server-seed', 'client', 0, 10);
  const b = floats('server-seed', 'client', 0, 10);
  assert.deepEqual(a, b);
  for (const f of a) { assert.ok(f >= 0 && f < 1); }
});

test('different nonce / client seed change the result', () => {
  assert.notDeepEqual(floats('s', 'c', 0, 4), floats('s', 'c', 1, 4));
  assert.notDeepEqual(floats('s', 'c1', 0, 4), floats('s', 'c2', 0, 4));
});

test('shuffle is a valid permutation and deterministic', () => {
  const p = shuffle(25, 'srv', 'cli', 7);
  assert.equal(p.length, 25);
  assert.deepEqual([...p].sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i));
  assert.deepEqual(p, shuffle(25, 'srv', 'cli', 7));
});

test('intBelow stays in range', () => {
  for (const f of floats('s', 'c', 3, 50)) assert.ok(intBelow(f, 37) >= 0 && intBelow(f, 37) < 37);
});

test('newServerSeed is 32 random bytes hex', () => {
  const s = newServerSeed();
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.notEqual(s, newServerSeed());
});
