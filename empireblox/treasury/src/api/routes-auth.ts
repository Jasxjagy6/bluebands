import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { registerUser, loginUser, destroySession, getProfile } from '../auth-user.js';
import { changePassword, renameUser } from '../auth-user.js';
import { getUserBalances } from '../ledger.js';
import { requireUser } from './guards.js';

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
    const b = z.object({ email: z.string().max(200), password: z.string().max(200) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Enter your email and password' });
    try {
      const { user, token } = await loginUser(b.data.email, b.data.password);
      reply.setCookie(SESSION_COOKIE, token, cookieOpts);
      return { user };
    } catch (e) {
      return reply.code(401).send({ error:'Wrong email or password' });
    }
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
      const b=z.object({current:z.string().min(1).max(200),password:z.string().min(8).max(200)}).safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter your current password and a new password of at least 8 characters.'});
      const token=await changePassword(req.userId!,b.data.current,b.data.password);
      if(!token)return reply.code(400).send({error:'Current password is incorrect.'});
      reply.setCookie(SESSION_COOKIE,token,cookieOpts);return {ok:true};
    });
    r.get('/api/auth/me', async (req) => {
      const profile = await getProfile(req.userId!);
      const balances = await getUserBalances(req.userId!);
      return { user: profile, balances };
    });
  });
}
