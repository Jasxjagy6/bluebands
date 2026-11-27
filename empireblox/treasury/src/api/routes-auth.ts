import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { registerUser, loginUser, destroySession, getProfile } from '../auth-user.js';
import { changePassword, renameUser } from '../auth-user.js';
import { getUserBalances } from '../ledger.js';
import { requireUser } from './guards.js';
import { query,tx } from '../db.js';
import { hashPassword,tokenHash } from '../authutil.js';
import { UserAuthError,accountPassword,authAttempt,consumeUserFactor,enableAuthenticator,securityEvent,setupAuthenticator } from '../user-2fa.js';

const SESSION_COOKIE = 'eb_sess';
const cookieOpts = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: config.cookieSecure,
  path: '/',
  maxAge: 30 * 86400,
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const b = z.object({
      email: z.string().email().max(200),
      username: z.string().min(2).max(20),
      password: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Check your details' });
    try {
      const { user, token } = await registerUser(b.data.email, b.data.username, b.data.password);
      reply.setCookie(SESSION_COOKIE, token, cookieOpts);
      return { user };
    } catch (e) {
      const message=e instanceof Error?e.message:'';
      return reply.code(400).send({error:/^(Username|That email|Enter a valid|Password must)/.test(message)?message:'Account creation unavailable'});
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ email: z.string().max(200), password: z.string().max(200),totp:z.string().max(64).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Enter your email and password' });
    try {
      const { user, token } = await loginUser(b.data.email, b.data.password,b.data.totp);
      reply.setCookie(SESSION_COOKIE, token, cookieOpts);
      return { user };
    } catch (e) {
      if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message,...(e.need2fa?{need2fa:true}:{})});
      return reply.code(401).send({ error:'Wrong email or password' });
    }
  });

  app.post('/api/auth/password/recover',async(req,reply)=>{
    const b=z.object({email:z.string().email().max(200),password:z.string().min(8).max(200),totp:z.string().min(1).max(64)}).strict().safeParse(req.body);
    if(!b.success)return reply.code(400).send({error:'Enter your email, a new password and an authenticator or recovery code.'});
    try{
      await authAttempt(b.data.email,'recover',5);
      await tx(async c=>{
        const u=(await c.query('select id from users where email=$1 and player_active(disabled,suspended_until) for update',[b.data.email.trim()])).rows[0];
        if(!u)throw new UserAuthError('Recovery could not be verified. Check your email and authenticator or recovery code.');
        await consumeUserFactor(c,u.id,b.data.totp,true);
        await c.query('update users set pass_hash=$2 where id=$1',[u.id,hashPassword(b.data.password)]);
        await c.query('delete from user_sessions where user_id=$1',[u.id]);
        await securityEvent(c,u.id,'security.password_recovered');
      });
      reply.clearCookie(SESSION_COOKIE,{path:'/'});return {ok:true};
    }catch(e){return reply.code(e instanceof UserAuthError&&e.statusCode===429?429:401).send({error:e instanceof UserAuthError&&e.statusCode===429?e.message:'Recovery could not be verified. Check your email and authenticator or recovery code.'});}
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = (req as any).cookies?.[SESSION_COOKIE];
    if (t) await destroySession(t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.patch('/api/auth/username',async(req,reply)=>{
      const b=z.object({username:z.string().regex(/^[A-Za-z0-9_]{2,20}$/)}).safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Use 2 to 20 letters, numbers or underscores.'});
      if(!await renameUser(req.userId!,b.data.username))return reply.code(409).send({error:'That username is taken.'});
      return {ok:true};
    });
    r.post('/api/auth/password',async(req,reply)=>{
      const b=z.object({current:z.string().min(1).max(200),password:z.string().min(8).max(200),totp:z.string().max(64).optional()}).safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter your current password and a new password of at least 8 characters.'});
      try{
      const token=await changePassword(req.userId!,b.data.current,b.data.password,b.data.totp);
      if(!token)return reply.code(400).send({error:'Current password is incorrect.'});
      reply.setCookie(SESSION_COOKIE,token,cookieOpts);return {ok:true};
      }catch(e){if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message,need2fa:e.need2fa});throw e;}
    });
    r.get('/api/auth/security',async(req)=>{
      const auth=(await query(`select enabled_at,(select count(*) from unnest(recovery_hashes))::int as recovery_codes_remaining
        from user_authenticators where user_id=$1 and enabled_at is not null`,[req.userId!])).rows[0];
      const sessions=(await query(`select created_at,last_seen_at,expires_at,token_hash=$2 as current
        from user_sessions where user_id=$1 and expires_at>clock_timestamp() order by last_seen_at desc limit 30`,[req.userId!,tokenHash(req.cookies.eb_sess||'')])).rows;
      const available=(await query("select value='true'::jsonb as ready from settings where key='player_2fa_available'")).rows[0]?.ready===true;
      return {totp_enabled:!!auth,setup_available:available,enabled_at:auth?.enabled_at??null,recovery_codes_remaining:auth?.recovery_codes_remaining??0,sessions};
    });
    r.post('/api/auth/2fa/setup',async(req,reply)=>{
      if((await query("select value='true'::jsonb as ready from settings where key='player_2fa_available'")).rows[0]?.ready!==true)return reply.code(503).send({error:'Authenticator setup is being prepared. Try again shortly.'});
      const b=z.object({password:z.string().min(1).max(200)}).strict().safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Enter your current password.'});
      try{await authAttempt(req.userId!,'2fa',10);return await tx(c=>setupAuthenticator(c,req.userId!,b.data.password));}
      catch(e){if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message});throw e;}
    });
    r.post('/api/auth/2fa/enable',async(req,reply)=>{
      if((await query("select value='true'::jsonb as ready from settings where key='player_2fa_available'")).rows[0]?.ready!==true)return reply.code(503).send({error:'Authenticator setup is being prepared. Try again shortly.'});
      const b=z.object({password:z.string().min(1).max(200),totp:z.string().regex(/^\d{6}$/)}).strict().safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter your password and a fresh six-digit authenticator code.'});
      try{await authAttempt(req.userId!,'2fa',10);return await tx(c=>enableAuthenticator(c,req.userId!,b.data.password,b.data.totp,req.cookies.eb_sess||''));}
      catch(e){if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message});throw e;}
    });
    r.post('/api/auth/2fa/disable',async(req,reply)=>{
      const b=z.object({password:z.string().min(1).max(200),totp:z.string().min(1).max(64)}).strict().safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter your current password and authenticator or recovery code.'});
      try{
        await authAttempt(req.userId!,'2fa',10);
        await tx(async c=>{
          await accountPassword(c,req.userId!,b.data.password);await consumeUserFactor(c,req.userId!,b.data.totp,true);
          await c.query('delete from user_authenticators where user_id=$1',[req.userId!]);
          await c.query('delete from user_sessions where user_id=$1 and token_hash<>$2',[req.userId!,tokenHash(req.cookies.eb_sess||'')]);
          await securityEvent(c,req.userId!,'security.2fa_disabled');
        });return {ok:true};
      }catch(e){if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message});throw e;}
    });
    r.post('/api/auth/sessions/revoke',async(req,reply)=>{
      const b=z.object({password:z.string().min(1).max(200),totp:z.string().max(64).optional()}).strict().safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter your password to sign out other sessions.'});
      try{
        await authAttempt(req.userId!,'sessions',10);
        await tx(async c=>{await accountPassword(c,req.userId!,b.data.password);await consumeUserFactor(c,req.userId!,b.data.totp);
          await c.query('delete from user_sessions where user_id=$1 and token_hash<>$2',[req.userId!,tokenHash(req.cookies.eb_sess||'')]);
          await securityEvent(c,req.userId!,'security.sessions_revoked');});return {ok:true};
      }catch(e){if(e instanceof UserAuthError)return reply.code(e.statusCode).send({error:e.message});throw e;}
    });
    r.get('/api/auth/me', async (req) => {
      const profile = await getProfile(req.userId!);
      const balances = await getUserBalances(req.userId!);
      return { user: profile, balances };
    });
  });
}
