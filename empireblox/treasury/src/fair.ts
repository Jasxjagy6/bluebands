import crypto from 'node:crypto';

// Provably-fair randomness (the Stake-style scheme).
//   - The server commits to a random serverSeed by publishing sha256(serverSeed)
//     BEFORE play. The player can set their own clientSeed. Each bet uses an
//     incrementing nonce. After the player rotates their seed, the old
//     serverSeed is revealed so every past result can be re-derived and checked.
//   - Results come from HMAC_SHA256(serverSeed, "clientSeed:nonce:cursor"),
//     turned into floats in [0,1). This module is pure and deterministic.

export function newServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSeed(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/** `count` independent floats in [0,1), deterministic for the same inputs. */
export function floats(serverSeed: string, clientSeed: string, nonce: number, count: number): number[] {
  const out: number[] = [];
  let cursor = 0;
  while (out.length < count) {
    const h = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${cursor}`)
      .digest();
    // Each group of 4 bytes -> one float in [0,1).
    for (let i = 0; i + 4 <= h.length && out.length < count; i += 4) {
      const f = h[i]! / 256 + h[i + 1]! / 256 ** 2 + h[i + 2]! / 256 ** 3 + h[i + 3]! / 256 ** 4;
      out.push(f);
    }
    cursor++;
  }
  return out;
}

/** A uniform integer in [0, n) from one float. */
export function intBelow(f: number, n: number): number {
  return Math.floor(f * n);
}

/**
 * A uniform random permutation of 0..n-1 (Fisher-Yates driven by the fair
 * floats). Used e.g. to place mines on a board deterministically & verifiably.
 */
export function shuffle(n: number, serverSeed: string, clientSeed: string, nonce: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  const fs = floats(serverSeed, clientSeed, nonce, n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(fs[n - 1 - i]! * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
