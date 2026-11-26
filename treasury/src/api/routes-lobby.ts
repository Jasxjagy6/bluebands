import { lockActivePlayer } from '../auth-user.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query,tx } from '../db.js';
import { requireUser } from './guards.js';
import { currentQuote, instantRound } from '../games/catalog.js';
import { createBattle, battleAction, listBattles } from '../games/battles.js';
import { MarketUnavailable } from '../games/prices.js';

const asset=z.string().min(1).max(32), pct=z.number().int().min(0).max(90);
const priced=z.object({asset,quote:z.string().uuid(),request:z.string().uuid()});
const instant=z.discriminatedUnion('game',[
  priced.extend({game:z.literal('cases'),case:z.string().min(1).max(64)}),
  priced.extend({game:z.literal('upgrader'),item:z.number().int().positive(),bet:z.string().min(1).max(40),over:z.boolean()})
]);
function failed(reply:FastifyReply,e:unknown){
  if((e as {statusCode?:number}).statusCode===403)return reply.code(403).send({error:'Account access restricted'});
  if(e instanceof MarketUnavailable)return reply.code(503).send({error:e.message});
  const m=e instanceof Error ? e.message : '';
  return reply.code(400).send({error:/^(Minimum bet|Maximum bet|Case |Choose |Finish |Insufficient |Currency |Price |Invalid amount|At most |Only the creator|Seat unavailable|Cannot join|Battle is|Wait |Message |Player )/.test(m)?m:'Request unavailable'});
}
export async function lobbyRoutes(app:FastifyInstance){
  app.get('/api/catalog',async()=>({
    levels:(await query('select * from levels order by level')).rows,
    packs:(await query('select * from reward_packs order by level')).rows,
    rewardItems:(await query('select * from reward_pack_items order by idx')).rows,
    cases:(await query('select * from cases where active order by sort')).rows,
    items:(await query('select * from case_items order by case_id,idx')).rows,
    upgrades:(await query('select id,name,value from upgrade_items order by value desc')).rows
  }));
  app.get('/api/quote/:asset',async(req,reply)=>{
    const p=z.object({asset}).parse(req.params);
    try { return await currentQuote(p.asset); }
    catch {return reply.code(503).send({error:'Market price unavailable. Try again shortly.'});}
  });
  app.get('/api/chat',async()=>({messages:(await query(`select m.id,m.user_id,u.username,m.body,m.created_at
    from player_chat m join users u on u.id=m.user_id order by m.id desc limit 80`)).rows.reverse()}));
  app.get('/api/players/:id',async(req,reply)=>{
    const p=z.object({id:z.string().uuid()}).safeParse(req.params);
    if(!p.success) return reply.code(404).send({error:'Player unavailable'});
    const row=(await query('select id,username,created_at from users where id=$1 and not disabled',[p.data.id])).rows[0];
    return row??reply.code(404).send({error:'Player unavailable'});
  });
  app.get('/api/leaderboard/:asset',async req=>{
    const p=z.object({asset}).parse(req.params);
    const rows=await query(`select u.id as user_id, u.username,(-sum(e.delta * power(10::numeric, case when $1='USDT' then 18-a.decimals else 0 end)))::numeric(100,0)::text as wagered from ledger_entries e
      join journals j on j.id=e.journal_id join users u on e.account='u:'||u.id::text
      join assets a on a.id=e.asset_id
      where j.kind like 'bet:%' and (e.asset_id=$1 or ($1='USDT' and a.symbol='USDT')) and not u.disabled and j.created_at>=date_trunc('week', now())
        and not exists(select 1 from journals refund where refund.kind='refund:battles' and j.kind='bet:battles' and refund.ref=j.ref)
      group by u.id order by -sum(e.delta * power(10::numeric, case when $1='USDT' then 18-a.decimals else 0 end)) desc,u.id limit 50`,[p.asset]);
    return {top:rows.rows,ends_at:(await query("select date_trunc('week',now())+interval '1 week' as ends_at")).rows[0].ends_at};
  });
  app.get('/api/battles/:asset',async req=>({battles:await listBattles(z.object({asset}).parse(req.params).asset)}));
  app.register(async r=>{
    r.addHook('preHandler',requireUser);
    r.get('/api/me/rewards',async req=>({claims:(await query('select level,claimed_at from reward_claims where user_id=$1',[req.userId])).rows,
      wagered:(await query('select catalog_wagered from users where id=$1',[req.userId])).rows[0].catalog_wagered}));
    r.get('/api/me/battles/:asset',async req=>({battles:await listBattles(z.object({asset}).parse(req.params).asset,req.userId)}));
    r.post('/api/games/instant',async(req,reply)=>{
      const b=instant.safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Check the bet details'});
      try{return await instantRound(req.userId!,b.data.asset,b.data.quote,b.data.request,b.data);}catch(e){return failed(reply,e);}
    });
    r.post('/api/games/battles',async(req,reply)=>{
      const b=priced.extend({mode:z.string().max(8),cases:z.array(z.string().max(64)).min(1).max(20),borrow:pct,crazy:z.boolean(),jackpot:z.boolean()}).safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Check the battle details'});
      try{return await createBattle(req.userId!,b.data);}catch(e){return failed(reply,e);}
    });
    r.post('/api/games/battles/:id',async(req,reply)=>{
      const p=z.object({id:z.string().uuid()}).safeParse(req.params),b=z.object({action:z.enum(['join','bots','cancel']),seat:z.number().int().min(0).max(5).nullable().default(null),borrow:pct.default(0),asset:asset.optional()}).safeParse(req.body);
      if(!p.success||!b.success)return reply.code(400).send({error:'Invalid battle action'});
      try{return await battleAction(req.userId!,p.data.id,b.data.action,b.data.seat,b.data.borrow,b.data.asset);}catch(e){return failed(reply,e);}
    });
    r.post('/api/chat',async(req,reply)=>{
      const b=z.object({body:z.string().trim().min(1).max(200)}).safeParse(req.body);
      if(!b.success) return reply.code(400).send({error:'Enter up to 200 characters'});
      try{return await tx(async c=>{
        await lockActivePlayer(c,req.userId!);
        const recent=await c.query("select 1 from player_chat where user_id=$1 and created_at>clock_timestamp()-interval '3 seconds'",[req.userId]);
        if(recent.rowCount)throw new Error('Wait three seconds between messages');
        await c.query('insert into player_chat(user_id,body) values($1,$2)',[req.userId,b.data.body]);
        return {ok:true};
      });}catch(e){return failed(reply,e);}
    });
    r.delete('/api/chat/:id',async(req,reply)=>{
      const id=z.object({id:z.string().regex(/^\d{1,18}$/)}).safeParse(req.params);
      if(!id.success) return reply.code(400).send({error:'Invalid message'});
      const admin=await query('select 1 from users where id=$1 and is_admin',[req.userId]);
      if(!admin.rowCount) return reply.code(403).send({error:'Moderator access required'});
      await query('delete from player_chat where id=$1',[id.data.id]);return {ok:true};
    });
  });
}
