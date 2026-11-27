import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { config } from '../config.js';
import { userRoutes } from './routes-user.js';
import { adminRoutes } from './routes-admin.js';
import { authRoutes } from './routes-auth.js';
import { gameRoutes } from './routes-games.js';

import { query } from '../db.js';
import { playerManagement } from './routes-players.js';
import { notificationRoutes } from './routes-notifications.js';
import { activityRoutes } from './routes-activity.js';
import { lobbyRoutes } from './routes-lobby.js';
import { custodyAdminRoutes } from './routes-custody.js';
import { sweepAdminRoutes } from './routes-sweeps.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.env === 'production' ? 'info' : 'debug' },
    trustProxy: (_address, hop) => hop === 0,
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((error,request,reply)=>{
    const status=error instanceof ZodError ? 400 : (error as {statusCode?:number}).statusCode ?? 500;
    if(status>=500) request.log.error({requestId:request.id},'Request failed');
    reply.code(status).send({error:status>=500?'Service temporarily unavailable':'Invalid request'});
  });
  await app.register(cors, {
    origin: config.allowOrigins.length ? config.allowOrigins : false,
    credentials: true,
  });
  await app.register(cookie);

  app.addHook('onRequest', async (req,reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control','private, no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
      const origin=req.headers.origin;
      if (origin!==req.protocol+'://'+req.headers.host && !config.allowOrigins.includes(origin))
        return reply.code(403).send({error:'Request origin unavailable'});
    }
    const route=req.routeOptions.url || '';
    const auth=['/api/auth/register','/api/auth/login','/api/auth/password','/api/auth/password/recover','/api/auth/sessions/revoke','/api/admin/login','/api/admin/2fa/enable'].includes(route)||route.startsWith('/api/auth/2fa/');
    if (!auth && route!=='/api/me/address/:chain') return;
    const hit=await query(`insert into api_rate_limits(ip,route,window_start,hits) values($1,$2,now(),1)
      on conflict(ip,route) do update set
        hits=case when api_rate_limits.window_start<now()-interval '1 minute' then 1 else least(api_rate_limits.hits+1,1000) end,
        window_start=case when api_rate_limits.window_start<now()-interval '1 minute' then now() else api_rate_limits.window_start end returning hits`,[req.ip,route]);
    if(hit.rows[0].hits>(auth?30:90)) return reply.header('Retry-After','60').code(429).send({error:'Too many requests. Try again shortly.'});
  });
  const prune=setInterval(()=>query("delete from api_rate_limits where window_start<now()-interval '1 hour'").catch(()=>{}),3600000);
  prune.unref(); app.addHook('onClose',async()=>{clearInterval(prune);});

  app.get('/healthz', async () => ({ ok: true }));

  // Serve the admin panel.
  const adminDir=join(here,'..','admin');
  // Compiled releases bundle the picker; tsx serves the same files from the frontend source tree.
  const pickerDir=existsSync(join(adminDir,'option-picker.js'))?adminDir:join(here,'..','..','..','assets','wallet');
  const pickerJs=readFileSync(join(pickerDir,'option-picker.js'),'utf8');
  const pickerHash='sha256-'+createHash('sha256').update(pickerJs).digest('base64');
  const adminHtml=readFileSync(join(adminDir,'index.html'),'utf8').replace('src="/admin/option-picker.js"',`src="/admin/option-picker.js" integrity="${pickerHash}"`);
  const pickerCss=readFileSync(join(pickerDir,'option-picker.css'),'utf8');
  app.get('/admin/option-picker.js',async(_req,reply)=>reply.header('Cache-Control','no-cache').type('application/javascript').send(pickerJs));
  app.get('/admin/option-picker.css',async(_req,reply)=>reply.header('Cache-Control','no-cache').type('text/css').send(pickerCss));
  const script=adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Admin application script missing');
  const adminScriptHash=createHash('sha256').update(script).digest('base64');
  app.get('/admin', async (_req, reply) => {
    reply.header('Cache-Control','no-store');
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'sha256-${adminScriptHash}' '${pickerHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    return reply.type('text/html').send(adminHtml);
  });

  await app.register(authRoutes);
  await app.register(gameRoutes);
  await app.register(lobbyRoutes);
  await app.register(activityRoutes);
  await app.register(playerManagement);
  await app.register(notificationRoutes);
  await app.register(userRoutes);
  await app.register(adminRoutes);
  await app.register(custodyAdminRoutes);
  await app.register(sweepAdminRoutes);

  return app;
}
