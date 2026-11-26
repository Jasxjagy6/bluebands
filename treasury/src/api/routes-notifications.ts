import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { verifySession } from '../auth-user.js';
import { requireUser } from './guards.js';

const cursor=z.string().regex(/^\d{1,18}$/);
async function head(uid:string){
  return (await query(`select coalesce((select revision from notification_heads where user_id=$1),0)::text as revision,
    (select count(*)::int from player_notifications where user_id=$1 and read_at is null) as unread`,[uid])).rows[0];
}
export async function notificationRoutes(app:FastifyInstance){
  // One lazy PostgreSQL subscription per replica. Each personal feed reads only its owner's rows.
  const events=new EventEmitter();events.setMaxListeners(0);
  let client:pg.Client|undefined,connecting:Promise<void>|undefined,closing=false;
  function listen(){
    if(client || closing)return Promise.resolve();
    if(!connecting)connecting=(async()=>{
      const db=new pg.Client({connectionString:config.databaseUrl,connectionTimeoutMillis:4000});
      db.on('error',()=>{if(client===db)client=undefined;});
      db.on('end',()=>{if(client===db)client=undefined;});
      db.on('notification',m=>{if(m.channel==='player_activity'&&m.payload)events.emit(m.payload);});
      try{await db.connect();await db.query('listen player_activity');if(closing)await db.end();else client=db;}
      catch(e){await db.end().catch(()=>{});throw e;}
    })().finally(()=>{connecting=undefined;});
    return connecting;
  }
  app.addHook('onClose',async()=>{closing=true;events.emit('shutdown');await connecting?.catch(()=>{});await client?.end();});
  app.addHook('preHandler',requireUser);
  app.get('/api/me/notifications',async req=>{
    const {before}=z.object({before:cursor.optional()}).parse(req.query);
    // Read the cursor and its page in one snapshot so a concurrent credit cannot be skipped.
    const result=await query(`select coalesce(h.revision,0)::text as head,
      (select count(*)::int from player_notifications where user_id=$1 and read_at is null) as unread,n.*,a.symbol,a.decimals
      from (values(1)) anchor(i) left join notification_heads h on h.user_id=$1
      left join lateral (select * from player_notifications where user_id=$1 and ($2::bigint is null or revision<$2)
        order by revision desc limit 21) n on true left join assets a on a.id=n.asset_id order by n.revision desc`,[req.userId,before??null]);
    const state=result.rows[0],rows=result.rows.filter(n=>n.revision!=null).map(({head,unread,...n})=>n);
    return {revision:state.head,unread:state.unread,rows:rows.slice(0,20),more:rows.length>20};
  });
  app.post('/api/me/notifications/read',async req=>{
    const {through}=z.object({through:cursor}).parse(req.body);
    await query(`with changed as (update player_notifications set read_at=now() where user_id=$1 and revision<=$2 and read_at is null returning 1)
      select pg_notify('player_activity',$1::uuid::text) where exists(select 1 from changed)`,[req.userId,through]);
    return head(req.userId!);
  });
  app.get('/api/me/notifications/changes',async(req,reply)=>{
    const {after}=z.object({after:cursor}).parse(req.query),uid=req.userId!;
    // Subscribe before checking the durable revision, closing the reconnect race.
    await listen().catch(()=>{});
    let wake!:()=>void;
    const changed=new Promise<void>(resolve=>{wake=resolve;});
    events.once(uid,wake);events.once('shutdown',wake);reply.raw.once('close',wake);
    const timeout=setTimeout(wake,client?18000:2000);
    try{
      const now=await head(uid);
      if(now.revision!==after)return now;
      if(!reply.raw.destroyed)await changed;
      if(!reply.raw.destroyed && !await verifySession(req.cookies.eb_sess||''))return reply.code(401).send({error:'Sign in to continue'});
      return await head(uid);
    }finally{clearTimeout(timeout);events.off(uid,wake);events.off('shutdown',wake);reply.raw.off('close',wake);}
  });
}
