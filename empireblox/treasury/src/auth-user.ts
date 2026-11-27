import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, tx, pool } from './db.js';
import { hashPassword, verifyPassword } from './authutil.js';
import { newServerSeed, hashSeed } from './fair.js';
import { allocateCustodyAddresses } from './derive.js';
import { authAttempt,consumeUserFactor,securityEvent } from './user-2fa.js';

const SESSION_DAYS = 30;

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Ensure a provably-fair seed exists for a user (called on register). */
async function ensureFair(c: PoolClient,userId: string): Promise<void> {
  const seed = newServerSeed();
  await c.query(
    `insert into user_fair(user_id, server_seed, server_seed_hash, client_seed)
     values ($1,$2,$3,$4) on conflict (user_id) do nothing`,
    [userId, seed, hashSeed(seed), crypto.randomBytes(8).toString('hex')],
  );
}

export type Profile = { id: string; email: string; username: string; is_admin: boolean };

// Serialize player-initiated money movements with a restriction imposed by an operator.
export async function lockActivePlayer(c:PoolClient,uid:string){
  await c.query("select pg_advisory_xact_lock_shared(hashtext('banditblox coin season boundary'))");
  const result=await c.query('select id from users where id=$1 and player_active(disabled,suspended_until) for update',[uid]);
  if(!result.rowCount)throw Object.assign(new Error('Account access restricted'),{statusCode:403});
}

export async function registerUser(email: string, username: string, password: string): Promise<{ user: Profile; token: string }> {
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) throw new Error('Username: 2 to 20 letters, numbers or underscores');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const hash = hashPassword(password);
  return tx(async c => {
    const r = await c.query<Profile>(`insert into users(email,username,pass_hash) values($1,$2,$3)
      on conflict do nothing returning id,email,username,is_admin`,[email,username,hash]);
    const user=r.rows[0];
    if(!user) throw new Error('That email or username is already taken');
    await ensureFair(c,user.id);
    // Issuance is opportunistic; e.g. a reserved-address collision must fail
    // closed for the wallet, not undo an otherwise valid account or session.
    await c.query('savepoint signup_addresses');
    try { await allocateCustodyAddresses(c,user.id); }
    catch {
      await c.query('rollback to savepoint signup_addresses');
      console.warn('[custody] signup address allocation deferred');
    }
    await c.query('release savepoint signup_addresses');
    return {user,token:await createSession(user.id,c)};
  });
}

export async function loginUser(email: string, password: string,totp?:string): Promise<{ user: Profile; token: string }> {
  await authAttempt(email,'login',30);
  if(totp)await authAttempt(email,'factor',10);
  return tx(async c=>{
    const u=(await c.query<Profile & {pass_hash:string;disabled:boolean}>(`select id,email,username,is_admin,pass_hash,disabled
      from users where email=$1 and player_active(disabled,suspended_until) for update`,[email.trim()])).rows[0];
    if (!u || u.disabled || !verifyPassword(password,u.pass_hash)) throw new Error('Wrong email or password');
    await consumeUserFactor(c,u.id,totp);
    const token=await createSession(u.id,c);
    return {user:{id:u.id,email:u.email,username:u.username,is_admin:u.is_admin},token};
  });
}

export async function createSession(userId:string, db:Pick<PoolClient,'query'>=pool): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.query(`insert into user_sessions(token_hash, user_id, expires_at) values ($1,$2,$3)`, [sha256(token), userId, exp]);
  return token;
}

/** Returns the user id for a valid, unexpired session token, else null. */
export async function verifySession(token: string): Promise<string | null> {
  if (!token) return null;
  const r = await query<{ user_id: string }>(
    `update user_sessions set last_seen_at=now()
       where token_hash=$1 and expires_at > now() and exists (select 1 from users where id=user_sessions.user_id and player_active(disabled,suspended_until))
     returning user_id`,
    [sha256(token)],
  );
  return r.rows[0]?.user_id ?? null;
}

export async function destroySession(token: string): Promise<void> {
  if (token) await query(`with ended as (delete from user_sessions where token_hash=$1 returning user_id)
    select pg_notify('player_activity',user_id::text) from ended`, [sha256(token)]);
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const r = await query<Profile>(`select id, email, username, is_admin, display_ccy, created_at,
    exists(select 1 from user_authenticators a where a.user_id=users.id and a.enabled_at is not null) as totp_enabled from users where id=$1`, [userId]);
  return r.rows[0] ?? null;
}

export async function renameUser(uid:string,name:string){
  try{return Boolean((await query('update users set username=$2 where id=$1',[uid,name])).rowCount);}
  catch(e){if((e as {code:string}).code==='23505')return false;throw e;}
}
export async function changePassword(uid:string,current:string,password:string,totp?:string){
  await authAttempt(uid,'password',10);
  return tx(async c=>{
    const u=(await c.query('select pass_hash from users where id=$1 and player_active(disabled,suspended_until) for update',[uid])).rows[0];
    if(!u || !verifyPassword(current,u.pass_hash))return null;
    await consumeUserFactor(c,uid,totp);
    await c.query('update users set pass_hash=$2 where id=$1',[uid,hashPassword(password)]);
    await c.query('delete from user_sessions where user_id=$1',[uid]);
    await securityEvent(c,uid,'security.password_changed');
    return createSession(uid,c);
  });
}
