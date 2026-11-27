import crypto from 'node:crypto';
import { query } from './db.js';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { config } from './config.js';

// ---------------------------------------------------------------------
// Envelope encryption.
//   KEK (key-encryption key) = TREASURY_MASTER_KEY, lives only in env/KMS.
//   For each secret we make a random DEK (data key), encrypt the secret
//   with the DEK, then encrypt the DEK with the KEK. Only ciphertext and
//   the wrapped DEK are stored. Nothing in the DB is usable without the KEK.
//   AES-256-GCM everywhere gives confidentiality + tamper detection.
// ---------------------------------------------------------------------

const KEK = Buffer.from(config.masterKeyB64, 'base64');

type Blob = { enc_dek: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer };

function gcmEnc(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function gcmDec(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Encrypt a value into the envelope blob format used by the DB. */
export function encryptBlob(plaintext: string | Buffer): Blob {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const dek = crypto.randomBytes(32);
  const payload = gcmEnc(dek, data);
  const wrapped = gcmEnc(KEK, dek); // encrypt the DEK itself under the KEK
  // enc_dek packs: [dekIv(12)][dekTag(16)][wrappedDek(32)]
  const enc_dek = Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct]);
  return { enc_dek, iv: payload.iv, tag: payload.tag, ciphertext: payload.ct };
}

/** Reverse of encryptBlob. Throws if the KEK is wrong or data was tampered. */
export function decryptBlob(b: Blob): Buffer {
  const dekIv = b.enc_dek.subarray(0, 12);
  const dekTag = b.enc_dek.subarray(12, 28);
  const dekCt = b.enc_dek.subarray(28);
  const dek = gcmDec(KEK, dekIv, dekTag, dekCt);
  return gcmDec(dek, b.iv, b.tag, b.ciphertext);
}

// ---------------------------------------------------------------------
// Named secrets (xpubs, RPC urls, RPC api keys). Set via admin panel.
// ---------------------------------------------------------------------

export async function setSecret(name: string, value: string, updatedBy: string, db:Pick<PoolClient,'query'>=pool): Promise<void> {
  const b = encryptBlob(value);
  const hint = value.length <= 6 ? '••••' : `…${value.slice(-4)}`;
  await db.query(
    `insert into secrets(name, enc_dek, iv, tag, ciphertext, hint, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (name) do update set
       enc_dek=$2, iv=$3, tag=$4, ciphertext=$5, hint=$6, updated_by=$7, updated_at=now()`,
    [name, b.enc_dek, b.iv, b.tag, b.ciphertext, hint, updatedBy],
  );
}

/** Returns the decrypted secret, or null if unset. Server-side only. */
export async function getSecret(name: string, db: Pick<PoolClient,'query'> = pool): Promise<string | null> {
  const r = await db.query<{ enc_dek: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer }>(
    `select enc_dek, iv, tag, ciphertext from secrets where name=$1`,
    [name],
  );
  if (!r.rows[0]) return null;
  return decryptBlob(r.rows[0]).toString('utf8');
}

/** Safe listing for the admin UI: names + hints only, never plaintext. */
export async function listSecretMeta(): Promise<{ name: string; hint: string | null; updated_at: string; updated_by: string | null }[]> {
  const r = await query(`select name, hint, updated_at, updated_by from secrets order by name`);
  return r.rows;
}

export async function deleteSecret(name: string, db:Pick<PoolClient,'query'>=pool): Promise<void> {
  await db.query(`delete from secrets where name=$1`, [name]);
}

/** Verify the KEK can actually decrypt by round-tripping a probe. */
export function selfTest(): boolean {
  const probe = 'treasury-vault-selftest';
  try {
    return decryptBlob(encryptBlob(probe)).toString('utf8') === probe;
  } catch {
    return false;
  }
}
