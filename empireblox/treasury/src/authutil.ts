import crypto from 'node:crypto';
import { pool, query } from './db.js';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Passwords: scrypt (built into Node, no native build step).
// Stored as "saltB64:hashB64".
// ---------------------------------------------------------------------
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pw, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ---------------------------------------------------------------------
// TOTP (RFC 6238), SHA-1, 6 digits, 30s step. For admin 2FA.
// ---------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret: string, counter: number): string {
  const key = b32decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** Accepts the current code plus one step either side (clock drift). */
export function verifyTotp(secret: string, token: string): boolean {
  return totpStep(secret,token)!==null;
}
export function totpStep(secret:string,token:string):number|null {
  const t = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const c of [counter - 1, counter, counter + 1]) {
    const expected = totpAt(secret, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t.padStart(6, '0')))) return c;
  }
  return null;
}

export function totpUri(secret: string, account: string, issuer = 'BANDITBLOX Treasury'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

// ---------------------------------------------------------------------
// Opaque admin sessions can be revoked independently of player sessions.
export const tokenHash = (token:string) => crypto.createHash('sha256').update(token).digest();
export async function signAdminToken(adminId: number, db:Pick<PoolClient,'query'>=pool): Promise<string> {
  const token=crypto.randomBytes(32).toString('base64url');
  await db.query('insert into admin_sessions(token_hash,admin_id) values($1,$2)',[tokenHash(token),adminId]);
  return token;
}
export async function verifyAdminToken(token:string) {
  const r=await query<{adminId:number;username:string}>(`select a.id::int as "adminId",a.username from admin_sessions s
    join admin_users a on a.id=s.admin_id where s.token_hash=$1 and s.expires_at>now() and not a.disabled`,[tokenHash(token)]);
  return r.rows[0]??null;
}
