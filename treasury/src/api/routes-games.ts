import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from './guards.js';
import { startMines, revealMines, cashoutMines, activeMines } from '../games/mines.js';

import { startBlackjack, actBlackjack, activeBlackjack } from '../games/blackjack.js';
import { lockSeeds } from '../game-seeds.js';
import { hashSeed, newServerSeed } from '../fair.js';
import { tx, query } from '../db.js';
import { publicLimits,readLimits } from '../games/wager-limits.js';
import { MarketUnavailable } from '../games/prices.js';

function fail(reply: any, e: unknown) {
  if((e as {statusCode?:number}).statusCode===403)return reply.code(403).send({error:'Account access restricted'});
  if(e instanceof MarketUnavailable)return reply.code(503).send({error:e.message});
  const message = e instanceof Error ? e.message : '';
  return reply.code(400).send({error: /^(Minimum bet|Maximum bet|Earlier stake|Insufficient|Enter a bet|Invalid amount|At most|No active|Bad tile|Pick |Finish your|Hand unavailable|Choose whether|Bet is too small|Double on your|Split requires|Action unavailable|Unknown currency|Currency unavailable)/.test(message) ? message : 'Game request unavailable'});
}

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/games/bet-limits',async()=>publicLimits(await readLimits()));
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.post('/api/games/blackjack/start', async (req, reply) => {
      const b = z.object({ asset:z.string().min(1).max(32), bet:z.string().max(40), request:z.string().uuid() }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error:'Check your bet' });
      try { return await startBlackjack(req.userId!, b.data.asset, b.data.bet, b.data.request); }
      catch (e) { return fail(reply,e); }
    });
    r.post('/api/games/blackjack/action', async (req, reply) => {
      const b = z.object({ id:z.string().uuid(), version:z.number().int().nonnegative(),
        action:z.enum(['hit','stand','double','split','insure','no_insure']) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error:'Invalid action' });
      try { return await actBlackjack(req.userId!, b.data.id, b.data.version, b.data.action); }
      catch (e) { return fail(reply,e); }
    });
    r.get('/api/games/blackjack/active', async req => ({ round:await activeBlackjack(req.userId!) }));
    r.get('/api/games/fair', async req => tx(async c => {
      const f = await lockSeeds(c,req.userId!);
      return { client:f.client_seed, hash:f.server_seed_hash, next_hash:hashSeed(f.next_seed), nonce:Number(f.nonce) };
    }));
    r.post('/api/games/fair/rotate', async (req,reply) => {
      const b = z.object({client:z.string().trim().min(1).max(64)}).safeParse(req.body);
      if (!b.success) return reply.code(400).send({error:'Enter a client seed'});
      return tx(async c => {
        const f = await lockSeeds(c,req.userId!);
        await c.query(`update user_fair set server_seed=next_seed,server_seed_hash=$2,next_seed=$3,client_seed=$4,nonce=0
          where user_id=$1`, [req.userId!,hashSeed(f.next_seed),newServerSeed(),b.data.client]);
        return {revealed:f.server_seed};
      });
    });
    r.get('/api/games/fair/bets', async req => (await query(`
      select * from (
        select 'mines' as game, server_seed_hash as seed_hash, client_seed, nonce::int8::text as nonce,
          case when status<>'active' then server_seed end as server_seed, json_build_object('mines',mines,'size',size) as detail, created_at
        from mines_rounds where user_id=$1
        union all select 'blackjack', server_seed_hash, client_seed, nonce::text,
          case when status='done' then server_seed end, '{}'::json, created_at from blackjack_rounds where user_id=$1
        union all select game,result->>'seed_hash',client_seed,nonce::text,server_seed,result::json,created_at from instant_rounds where user_id=$1
      ) bets order by created_at desc limit 40`,[req.userId!])).rows);

    r.post('/api/games/mines/start', async (req, reply) => {
      const b = z.object({
        asset: z.string().min(1).max(32),
        bet: z.string().min(1).max(40),
        request:z.string().uuid().optional(),
        size: z.number().int(),
        mines: z.number().int(),
      }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'Check your bet' });
      try { return await startMines(req.userId!, b.data.asset, b.data.bet, b.data.size, b.data.mines, b.data.request); }
      catch (e) { return fail(reply, e); }
    });

    r.post('/api/games/mines/reveal', async (req, reply) => {
      const b = z.object({ tile:z.number().int(), id:z.string().regex(/^\d{1,18}$/).optional() }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'Bad tile' });
      try { return await revealMines(req.userId!, b.data.tile,b.data.id); }
      catch (e) { return fail(reply, e); }
    });

    r.post('/api/games/mines/cashout', async (req, reply) => {
      const b=z.object({id:z.string().regex(/^\d{1,18}$/).optional()}).safeParse(req.body??{});
      if (!b.success) return reply.code(400).send({error:'Bad round'});
      try { return await cashoutMines(req.userId!,b.data.id); }
      catch (e) { return fail(reply, e); }
    });

    r.get('/api/games/mines/active', async (req) => ({ round: await activeMines(req.userId!) }));
  });
}
