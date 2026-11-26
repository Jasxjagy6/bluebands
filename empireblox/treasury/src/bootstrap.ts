import { query } from './db.js';
import { hashPassword } from './authutil.js';

/**
 * On first boot, create the admin from ADMIN_EMAIL / ADMIN_PASSWORD so a
 * fresh deploy always has a working login. It does NOT overwrite an existing
 * admin, so a password you later change in place is never clobbered by a
 * restart. The email is stored as the admin's username.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) return;
  const existing = await query(`select id from admin_users where username=$1`, [email]);
  if (existing.rows[0]) return;
  await query(
    `insert into admin_users(username, pass_hash) values ($1,$2) on conflict (username) do nothing`,
    [email, hashPassword(pw)],
  );
  console.log(`[bootstrap] admin account "${email}" created`);
}
