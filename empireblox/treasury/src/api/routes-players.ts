import { lockActivePlayer } from '../auth-user.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser } from './guards.js';
import { query, tx } from '../db.js';
import { balanceOf, getUserBalances, post } from '../ledger.js';
import { parseAmount } from '../money.js';
import { coinRewards } from '../games/rewards.js';

const uidParam=z.object({uid:z.string().uuid()});
const paging=z.object({page:z.coerce.number().int().min(0).max(100000).default(0)});
const statusSql="case when disabled then 'banned' when suspended_until>now() then 'suspended' else 'active' end";
const profileColumns=`id,email,username,created_at,display_ccy,suspended_until,${statusSql} as status`;
const pages=(rows:unknown[])=>({rows:rows.slice(0,20),more:rows.length>20});

const common={request:z.string().uuid(),reason:z.string().trim().min(1).max(300)};
const adjustment=z.object({...common,action:z.enum(['credit','debit']),asset:z.string().min(1).max(32),amount:z.string().max(60)});
const control=z.union([adjustment,z.object({...common,action:z.enum(['ban','restore'])}),
  z.object({...common,action:z.literal('suspend'),until:z.string().datetime({offset:true})}),
  z.object({...common,action:z.enum(['hold_deposit','release_deposit']),deposit:z.string().regex(/^\d{1,18}$/)})]);
class ControlError extends Error {}
export async function playerManagement(app:FastifyInstance){
  app.get('/api/reward-levels',async()=>({program:'daily_coins',levels:(await query('select level,xp::text from levels order by level')).rows,packs:(await query('select * from reward_packs order by level')).rows}));
  app.register(async r=>{
    r.addHook('preHandler',requireUser);
    r.get('/api/me/levels',req=>coinRewards(req.userId!));
    r.post('/api/me/levels/:level/claim',async(_req,reply)=>reply.code(410).send({error:'The old VIP bonus program is retired. Open daily coin reward packs instead.'}));
  });
  app.register(async r=>{
    r.addHook('preHandler',requireAdmin);
    r.get('/api/admin/users',async req=>{
      const p=paging.extend({q:z.string().trim().max(200).default(''),status:z.enum(['all','active','suspended','banned']).default('all')}).parse(req.query);
      const rows=await query(`select ${profileColumns} from users where ($2='all' or ${statusSql}=$2) and
        ($1='' or strpos(lower(username::text),lower($1))>0 or strpos(lower(email::text),lower($1))>0 or strpos(id::text,lower($1))>0)
        order by created_at desc,id desc limit 21 offset $3`,[p.q,p.status,p.page*20]);
      return pages(rows.rows);
    });
    r.get('/api/admin/users/:uid',async(req,reply)=>{
      const {uid}=uidParam.parse(req.params);
      const user=(await query(`select ${profileColumns},is_admin from users where id=$1`,[uid])).rows[0];
      if(!user)return reply.code(404).send({error:'Player unavailable'});
      const [balances,activity,rewards,addresses]=await Promise.all([getUserBalances(uid),query(`select count(*)::int as bets,
        count(*) filter(where status in ('cashed','done','rolling','lost') and payout>stake)::int as wins from player_bets where user_id=$1 and stake>0`,[uid]),
        coinRewards(uid),query('select chain_id,address from deposit_addresses where user_id=$1 order by chain_id',[uid])]);
      return {user,balances,activity:activity.rows[0],rewards,addresses:addresses.rows};
    });
    r.get('/api/admin/users/:uid/deposits',async req=>{
      const {uid}=uidParam.parse(req.params),p=paging.extend({pending:z.enum(['true','false']).default('false')}).parse(req.query);
      return pages((await query(`select d.*,a.decimals,a.symbol from deposit_records d join assets a on a.id=d.asset_id
        where d.user_id=$1 and (not $2::boolean or d.status in ('pending','confirmed','creating','waiting','paying','underpaid','review')) order by d.first_seen_at desc,d.id desc limit 21 offset $3`,[uid,p.pending,p.page*20])).rows);
    });
    r.get('/api/admin/users/:uid/withdrawals',async req=>{
      const {uid}=uidParam.parse(req.params),{page}=paging.parse(req.query);
      return pages((await query(`select w.*,a.symbol,a.decimals,u.username as reviewer from withdrawals w join assets a on a.id=w.asset_id
        left join admin_users u on u.id=w.reviewer_id where w.user_id=$1 order by w.created_at desc,w.id desc limit 21 offset $2`,[uid,page*20])).rows);
    });
    r.get('/api/admin/users/:uid/actions',async req=>{
      const {uid}=uidParam.parse(req.params),{page}=paging.parse(req.query);
      return pages((await query(`select p.id,p.action,p.reason,p.details,p.journal_id,p.created_at,a.username as actor from player_admin_actions p
        join admin_users a on a.id=p.actor_id where p.user_id=$1 order by p.created_at desc,p.id desc limit 21 offset $2`,[uid,page*20])).rows);
    });
    r.post('/api/admin/users/:uid/actions',async(req,reply)=>{
      const {uid}=uidParam.parse(req.params),input=control.parse(req.body);
      const {request,reason,...details}=input;
      try{return await tx(async c=>{
        const user=await c.query('select id from users where id=$1 for update',[uid]);
        if(!user.rowCount)throw new ControlError('Player unavailable');
        const prior=(await c.query(`select user_id=$2 and actor_id=$3 and reason=$4 and details=$5::jsonb as same,journal_id
          from player_admin_actions where id=$1`,[request,uid,req.admin!.adminId,reason,details])).rows[0];
        if(prior){if(!prior.same)throw new ControlError('Request already used');return {ok:true,journal_id:prior.journal_id};}
        let journal:string|null=null;
        if('amount' in input){
          const asset=(await c.query("select decimals from assets where id=$1 and kind in ('native','ledger')",[input.asset])).rows[0];
          if(!asset)throw new ControlError('Choose a playable currency');
          let units:bigint;
          try{units=parseAmount(input.amount,asset.decimals);}catch{throw new ControlError('Check the amount and decimal places');}
          if(units<=0n)throw new ControlError('Enter a positive amount');
          if(input.action==='debit'){
            if(await balanceOf(c,'u:'+uid,input.asset,true)<units)throw new ControlError('Insufficient available balance');
            units=-units;
          }
          journal=await post(c,'admin_'+input.action,request,[{account:'u:'+uid,asset:input.asset,delta:units},{account:'house:adjustments',asset:input.asset,delta:-units}]);
          await c.query('select notify_player($1,$2,$3,$4,$5)',[uid,'balance.'+input.action,request,input.asset,units.toString()]);
        }else if('deposit' in input){
          const hold=input.action==='hold_deposit';
          const changed=await c.query(`update deposits set review_hold=$3 where id=$1 and user_id=$2 and review_hold<>$3 and journal_id is null
            and status in ('pending','confirmed') returning id`,[input.deposit,uid,hold]);
          if(!changed.rowCount)throw new ControlError('Deposit status changed. Refresh the record.');
          // The watcher rechecks the canonical block before releasing the credit on its next scan.
        }else{
          const until=input.action==='suspend'?input.until:null;
          if(until && Date.parse(until)<=Date.now())throw new ControlError('Choose a future suspension end');
          await c.query('update users set disabled=$2,suspended_until=$3 where id=$1',[uid,input.action==='ban',until]);
          if(input.action!=='restore'){
            await c.query('delete from user_sessions where user_id=$1',[uid]);
            await c.query("select pg_notify('player_activity',$1)",[uid]);
          }
        }
        await c.query('insert into player_admin_actions(id,user_id,actor_id,action,reason,details,journal_id) values($1,$2,$3,$4,$5,$6,$7)',
          [request,uid,req.admin!.adminId,input.action,reason,details,journal]);
        await c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',[req.admin!.username,'player.'+input.action,{user_id:uid,request,reason,...details},req.ip]);
        return {ok:true,journal_id:journal};
      });}catch(err){
        if(err instanceof ControlError)return reply.code(409).send({error:err.message});
        if((err as {code?:string}).code==='23505')return reply.code(409).send({error:'Request already used'});
        throw err;
      }
    });
  });
}
