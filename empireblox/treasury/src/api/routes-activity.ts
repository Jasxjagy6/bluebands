import { lockActivePlayer } from '../auth-user.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAddress } from 'ethers';
import { bech32,bech32m,base58,base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { requireUser,requireAdmin } from './guards.js';
import { query,tx } from '../db.js';
import { balanceOf,post } from '../ledger.js';
import { parseAmount } from '../money.js';
import { supportedAssets, validSolOwner } from '../chains/receive.js';

const page=z.object({page:z.coerce.number().int().min(0).max(100000).default(0),asset:z.string().max(32).optional(),game:z.enum(['mines','blackjack','cases','upgrader','battles','rewards']).optional()});
const transactionKinds=z.enum(['all','deposits','withdrawals','bets','rewards','adjustments']);
const transactionPage=page.extend({type:transactionKinds.default('all')});
const limit=20;
const usdtFilter="(a.id=$2 or (a.symbol='USDT' and $2='USDT'))";
function destinationValid(chain:string,address:string){
  try{
    if(['ETH','BSC','POL'].includes(chain))return Boolean(getAddress(address)) && !/^0x0{40}$/i.test(address);
    if(chain==='SOL')return validSolOwner(address);
    if(chain==='TRON'){const b=base58check(sha256).decode(address);return b.length===21 && b[0]===65;}
    if(chain==='BTC'){
      if(address.startsWith('bc1')){
        const enc=address.startsWith('bc1q')?bech32:bech32m,decoded=enc.decode(address as `${string}1${string}`),v=decoded.words[0]!,bytes=enc.fromWords(decoded.words.slice(1));
        return decoded.prefix==='bc' && v<=16 && (v===0?[20,32].includes(bytes.length):bytes.length>=2 && bytes.length<=40);
      }
      const b=base58check(sha256).decode(address);return b.length===21 && [0,5].includes(b[0]!);
    }
  }catch{}
  return false;
}
const betColumns=`b.id,b.game,b.status,b.asset_id,a.symbol,a.decimals,b.stake::text,b.payout::text,b.created_at`;
function historyRoutes(r:FastifyInstance,prefix:string,owner:(req:import('fastify').FastifyRequest)=>string){
    r.get(prefix+'/transactions',async req=>{
      const p=transactionPage.parse(req.query);
      const rows=await query(`select e.id,e.asset_id,e.delta::text,a.symbol,a.decimals,j.kind,j.ref,j.created_at,
        d.provider,coalesce(d.chain_id,w.chain_id) as chain_id,coalesce(d.txid,w.txid) as txid,w.status as withdrawal_status from ledger_entries e join journals j on j.id=e.journal_id join assets a on a.id=e.asset_id
        left join deposit_records d on d.journal_id=j.id left join withdrawals w on j.kind in ('withdrawal_hold','withdrawal_refund') and j.ref=w.id::text and w.user_id=$1::uuid where e.account='u:'||$1::text and j.kind<>'currency_consolidation'
        and ($2::text is null or ${usdtFilter})
        and ($4='all' or $4=case
          when j.kind='deposit' then 'deposits'
          when j.kind in ('withdrawal_hold','withdrawal_refund','withdrawal_sent') then 'withdrawals'
          when j.kind in ('level_bonus','payout:rewards') then 'rewards'
          when split_part(j.kind,':',1) in ('bet','payout','refund') then 'bets'
          when j.kind in ('admin_credit','admin_debit') then 'adjustments' end)
        order by e.id desc limit 21 offset $3`,[owner(req),p.asset??null,p.page*limit,p.type]);
      return {rows:rows.rows.slice(0,limit),more:rows.rows.length>limit};
    });
    r.get(prefix+'/bets',async req=>{
      const p=page.parse(req.query);
      const rows=await query(`select ${betColumns} from player_bets b join assets a on a.id=b.asset_id where b.user_id=$1
        and ($2::text is null or ${usdtFilter}) and ($3::text is null or b.game=$3)
        order by b.created_at desc,b.game,b.id desc limit 21 offset $4`,[owner(req),p.asset??null,p.game??null,p.page*limit]);
      return {rows:rows.rows.slice(0,limit),more:rows.rows.length>limit};
    });
    r.get(prefix+'/bets/:game/:id',async(req,reply)=>{
      const params=z.object({game:z.string().max(20),id:z.string().max(80)}).parse(req.params);
      const row=(await query(`select ${betColumns},b.detail from player_bets b join assets a on a.id=b.asset_id
        where b.user_id=$1 and b.game=$2 and b.id=$3`,[owner(req),params.game,params.id])).rows[0];
      return row??reply.code(404).send({error:'Bet unavailable'});
    });
    r.get(prefix+'/stats',async(req,reply)=>{
      const p=z.object({asset:z.string().max(32).default('USDT'),days:z.coerce.number().refine(n=>[7,30,90].includes(n)).default(7)}).parse(req.query);
      const asset=(await query('select symbol,decimals from assets where id=$1',[p.asset])).rows[0];
      if(!asset)return reply.code(400).send({error:'Unknown currency'});
      const rows=await query(`with days as (select ((now() at time zone 'UTC')::date - i)::date as day from generate_series(0,$3::int-1) i),
        rounds as (select (b.created_at at time zone 'UTC')::date as day,b.stake*power(10::numeric,$4-a.decimals) as stake,
          b.payout*power(10::numeric,$4-a.decimals) as payout,b.usdt,b.unpriced_usdt from vip_wagers b join assets a on a.id=b.asset_id
          where b.user_id=$1 and b.created_at >= (((now() at time zone 'UTC')::date - ($3::int-1))::timestamp at time zone 'UTC')
          and ${usdtFilter})
        select to_char(d.day,'YYYY-MM-DD') as day,count(r.stake)::int as bets,count(*) filter(where r.payout>r.stake)::int as wins,
          coalesce(sum(stake),0)::numeric(100,0)::text as stake,coalesce(sum(payout),0)::numeric(100,0)::text as payout,
           trim_scale(coalesce(sum(r.usdt),0))::text as wagered_usdt,count(*) filter(where r.unpriced_usdt)::int as unpriced_usdt
        from days d left join rounds r on r.day=d.day group by d.day order by d.day`,[owner(req),p.asset,p.days,asset.decimals]);
      return {asset_id:p.asset,...asset,days:rows.rows};
    });
}
export async function activityRoutes(app:FastifyInstance){
  app.register(async r=>{
    r.addHook('preHandler',requireUser);
    historyRoutes(r,'/api/me',req=>req.userId!);
    r.get('/api/me/withdrawals',async req=>({rows:(await query(`select w.id,w.chain_id,w.route_asset,w.amount,w.destination,w.txid,w.created_at,w.status,a.symbol,a.decimals from withdrawals w join assets a on a.id=w.asset_id
      where user_id=$1 order by created_at desc limit 50`,[req.userId])).rows}));
    r.post('/api/me/withdrawals',async(req,reply)=>{
      const b=z.object({request:z.string().uuid(),route:z.string().max(32),amount:z.string().min(1).max(60),destination:z.string().trim().min(1).max(100)}).safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Check the withdrawal details'});
      const f=b.data;
      try{return await tx(async c=>{
        await lockActivePlayer(c,req.userId!);
        const prior=(await c.query(`select w.id,w.status,w.route_asset,w.destination,w.amount,a.decimals
          from withdrawals w join assets a on a.id=w.asset_id where w.user_id=$1 and request=$2`,[req.userId,f.request])).rows[0];
        if(prior){
          if(prior.route_asset!==f.route || prior.destination!==f.destination || BigInt(prior.amount)!==parseAmount(f.amount,prior.decimals))
            throw new Error('Check the request details and use a new request for a different withdrawal');
          return {id:prior.id,status:prior.status};
        }
        const route=(await c.query(`select a.* from assets a join chains n on n.id=a.chain_id where a.id=$1 and a.enabled and n.enabled and ${supportedAssets}`,[f.route])).rows[0];
        if(!route || !destinationValid(route.chain_id,f.destination))throw new Error('Check the destination address and network');
        const asset=route.symbol==='USDT'?'USDT':route.id, dec=asset==='USDT'?18:route.decimals;
        const units=parseAmount(f.amount,route.decimals)*10n**BigInt(dec-route.decimals);
        if(units<=0n)throw new Error('Enter a positive amount');
        if(units>await balanceOf(c,'u:'+req.userId,asset,true))throw new Error('Insufficient available balance');
        const id=randomUUID();
        await post(c,'withdrawal_hold',id,[{account:'u:'+req.userId,asset,delta:-units},{account:'hold:'+id,asset,delta:units}]);
        await c.query(`insert into withdrawals(id,user_id,request,asset_id,route_asset,chain_id,destination,amount) values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id,req.userId,f.request,asset,f.route,route.chain_id,f.destination,units.toString()]);return {id,status:'requested'};
      });}catch(e){if((e as {statusCode?:number}).statusCode===403)throw e;const msg=(e as Error).message;return reply.code(400).send({error:/^(Check|Insufficient|Enter a positive|Invalid amount|At most)/.test(msg)?msg:'Withdrawal unavailable'});}
    });
    r.post('/api/me/withdrawals/:id/cancel',async(req,reply)=>{
      const p=z.object({id:z.string().uuid()}).parse(req.params);
      const ok=await tx(async c=>{
        await lockActivePlayer(c,req.userId!);
        const w=(await c.query("update withdrawals set status='cancelled',updated_at=now() where id=$1 and user_id=$2 and status='requested' returning *",[p.id,req.userId])).rows[0];
        if(!w)return false;
        await post(c,'withdrawal_refund',w.id,[{account:'hold:'+w.id,asset:w.asset_id,delta:-BigInt(w.amount)},{account:'u:'+w.user_id,asset:w.asset_id,delta:BigInt(w.amount)}]);return true;
      });
      return ok?{ok}:reply.code(409).send({error:'This withdrawal can no longer be cancelled'});
    });
  });
  app.register(async r=>{
    r.addHook('preHandler',requireAdmin);
    historyRoutes(r,'/api/admin/users/:uid',req=>z.object({uid:z.string().uuid()}).parse(req.params).uid);
    r.get('/api/admin/withdrawals',async req=>{
      const p=z.object({scope:z.enum(['open','history']).default('open'),page:z.coerce.number().int().min(0).max(100000).default(0)}).parse(req.query);
      const rows=(await query(`select w.*,a.decimals,a.symbol,u.email,u.username,reviewer.username as reviewer
        from withdrawals w join users u on u.id=w.user_id join assets a on a.id=w.asset_id left join admin_users reviewer on reviewer.id=w.reviewer_id
        where (w.status in ('requested','reviewing','approved'))=($1='open')
        order by case when $1='open' then w.created_at end,w.created_at desc,w.id limit 21 offset $2`,[p.scope,p.page*20])).rows;
      return {rows:rows.slice(0,20),more:rows.length>20};
    });
    r.post('/api/admin/withdrawals/:id',async(req,reply)=>{
      const p=z.object({id:z.string().uuid()}).parse(req.params),b=z.object({action:z.enum(['review','approve','sent','return']),txid:z.string().max(100).optional()}).parse(req.body);
      let changed;
      try {
        changed=await tx(async c=>{
          const w=(await c.query(`select w.*,a.decimals as route_decimals from withdrawals w join assets a on a.id=w.route_asset
            where w.id=$1 for update of w`,[p.id])).rows[0];
          if(!w)return false;
          const review=b.action==='review';
          const allowed=review ? w.status==='requested' :
            w.reviewer_id===req.admin!.adminId && (b.action==='approve'?w.status==='reviewing':b.action==='sent'?w.status==='approved':['reviewing','approved'].includes(w.status));
          if(!allowed)return false;
          let hash=b.txid || '';
          const units=BigInt(w.amount);
          if(b.action==='sent'){
            if(w.chain_id==='SOL'){
              try{if(base58.decode(hash).length!==64)return false;}catch{return false;}
            }else{
              const pattern=['ETH','POL','BSC'].includes(w.chain_id)?/^0x[\da-f]{64}$/i:/^[\da-f]{64}$/i;
              if(!pattern.test(hash))return false;
              hash=hash.toLowerCase();
            }
            const legs=[{account:'hold:'+w.id,asset:w.asset_id,delta:-units}];
            if(w.route_asset!==w.asset_id){
              const chainUnits=units/10n**BigInt(18-w.route_decimals);
              legs.push({account:'bridge:USDT',asset:w.asset_id,delta:units},{account:'bridge:USDT',asset:w.route_asset,delta:-chainUnits},
                {account:'ext:'+w.chain_id,asset:w.route_asset,delta:chainUnits});
            }else legs.push({account:'ext:'+w.chain_id,asset:w.asset_id,delta:units});
            await post(c,'withdrawal_sent',w.id,legs);
          }
          if(b.action==='return')await post(c,'withdrawal_refund',w.id,[
            {account:'hold:'+w.id,asset:w.asset_id,delta:-units},{account:'u:'+w.user_id,asset:w.asset_id,delta:units}]);
          await c.query('update withdrawals set status=$2,txid=$3,reviewer_id=$4,updated_at=now() where id=$1',
            [w.id,{review:'reviewing',approve:'approved',return:'cancelled',sent:'sent'}[b.action],b.action==='sent'?hash:null,req.admin!.adminId]);
          await c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',
            [req.admin!.username,'withdrawal.'+b.action,{id:w.id,txid:b.action==='sent'?hash:undefined},req.ip]);
          return true;
        });
      }catch(error){
        if((error as {code?:string}).code!=='23505')throw error;
        return reply.code(409).send({error:'This transaction ID is already recorded on this network'});
      }
      return changed?{ok:true}:reply.code(409).send({error:'Check the assigned reviewer, request status and transaction ID'});
    });
  });
}
