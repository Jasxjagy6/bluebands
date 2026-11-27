import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from './db.js';
import { encryptBlob,decryptBlob } from './vault.js';
import { newTotpSecret,totpStep,totpUri,tokenHash,verifyPassword } from './authutil.js';

export class UserAuthError extends Error {
  constructor(message:string,readonly statusCode=401,readonly need2fa=false){super(message);}
}
/** Independent committed counters survive a failed authentication transaction. */
export async function authAttempt(identifier:string,action:string,limit=10){
  const row=(await query(`insert into api_rate_limits(ip,route,window_start,hits) values($1,$2,clock_timestamp(),1)
    on conflict(ip,route) do update set hits=case when api_rate_limits.window_start<clock_timestamp()-interval '15 minutes'
      then 1 else least(api_rate_limits.hits+1,1000) end,
      window_start=case when api_rate_limits.window_start<clock_timestamp()-interval '15 minutes' then clock_timestamp() else api_rate_limits.window_start end
    returning hits`,['player-auth:'+tokenHash(identifier.trim().toLowerCase()).toString('hex'),'account:'+action])).rows[0];
  if(row.hits>limit)throw new UserAuthError('Too many attempts. Try again in 15 minutes.',429);
}
export async function consumeUserFactor(c:PoolClient,uid:string,code?:string,required=false){
  const row=(await c.query('select * from user_authenticators where user_id=$1 and enabled_at is not null for update',[uid])).rows[0];
  if(!row){if(required)throw new UserAuthError('Recovery could not be verified. Check your email and authenticator or recovery code.');return;}
  if(!code)throw new UserAuthError('Enter your authenticator or recovery code.',401,true);
  const value=code.replace(/[\s-]/g,'').toUpperCase();
  if(/^\d{6}$/.test(value)){
    const secret=decryptBlob(row);let step:number|null;
    try{step=totpStep(secret.toString('utf8'),value);}finally{secret.fill(0);}
    if(step===null||step<=Number(row.last_step))throw new UserAuthError('Code is invalid or already used. Enter a fresh code.',401,true);
    await c.query('update user_authenticators set last_step=$2 where user_id=$1',[uid,step]);return;
  }
  if(/^[A-F0-9]{20}$/.test(value)){
    const candidate=tokenHash(uid+':'+value),hashes:Buffer[]=row.recovery_hashes;
    const found=hashes.findIndex(hash=>hash.length===candidate.length&&timingSafeEqual(hash,candidate));
    if(found>=0){hashes.splice(found,1);await c.query('update user_authenticators set recovery_hashes=$2 where user_id=$1',[uid,hashes]);return;}
  }
  throw new UserAuthError('Code is invalid or already used. Enter a fresh code.',401,true);
}
export async function accountPassword(c:PoolClient,uid:string,password:string){
  const user=(await c.query('select id,email,pass_hash from users where id=$1 and player_active(disabled,suspended_until) for update',[uid])).rows[0];
  if(!user||!verifyPassword(password,user.pass_hash))throw new UserAuthError('Current password is incorrect.');
  return user;
}
export async function securityEvent(c:PoolClient,uid:string,kind:string){
  const ref='security:'+randomUUID();
  await c.query('insert into audit_log(actor,action,detail) values($1,$2,$3)',[uid,kind,{user_id:uid}]);
  await c.query('select notify_player($1,$2,$3,null,null)',[uid,kind,ref]);
}
export async function setupAuthenticator(c:PoolClient,uid:string,password:string){
  const user=await accountPassword(c,uid,password);
  const existing=(await c.query('select enabled_at from user_authenticators where user_id=$1 for update',[uid])).rows[0];
  if(existing?.enabled_at)throw new UserAuthError('Your authenticator is already enabled.',409);
  const secret=newTotpSecret(),blob=encryptBlob(secret);
  await c.query(`insert into user_authenticators(user_id,enc_dek,iv,tag,ciphertext,setup_expires_at)
    values($1,$2,$3,$4,$5,clock_timestamp()+interval '10 minutes') on conflict(user_id) do update
    set enc_dek=$2,iv=$3,tag=$4,ciphertext=$5,setup_expires_at=clock_timestamp()+interval '10 minutes',last_step=-1`,
  [uid,blob.enc_dek,blob.iv,blob.tag,blob.ciphertext]);
  return {secret,uri:totpUri(secret,user.email,'BANDITBLOX'),expires_in:600};
}
export async function enableAuthenticator(c:PoolClient,uid:string,password:string,code:string,sessionToken:string){
  await accountPassword(c,uid,password);
  const row=(await c.query('select *,setup_expires_at>clock_timestamp() as valid from user_authenticators where user_id=$1 for update',[uid])).rows[0];
  if(!row||row.enabled_at||!row.valid)throw new UserAuthError('Setup expired or is already enabled. Start again.',409);
  const secret=decryptBlob(row);let step:number|null;
  try{step=totpStep(secret.toString('utf8'),code);}finally{secret.fill(0);}
  if(step===null)throw new UserAuthError('Authenticator code did not match. Try a fresh code.');
  const codes=Array.from({length:10},()=>randomBytes(10).toString('hex').toUpperCase().match(/.{5}/g)!.join('-'));
  await c.query(`update user_authenticators set enabled_at=clock_timestamp(),setup_expires_at=null,last_step=$2,recovery_hashes=$3 where user_id=$1`,
  [uid,step,codes.map(code=>tokenHash(uid+':'+code.replaceAll('-','')))]);
  await c.query('delete from user_sessions where user_id=$1 and token_hash<>$2',[uid,tokenHash(sessionToken)]);
  await securityEvent(c,uid,'security.2fa_enabled');
  return {ok:true,recovery_codes:codes};
}
