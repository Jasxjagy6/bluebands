import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query,tx } from '../db.js';
import { requireAdmin } from './guards.js';
import { feeWalletReport } from '../custody/reporting.js';
import { sweepChains } from '../custody/types.js';

const statuses=['queued','sponsor_signed','sponsor_pending','sponsored','sweep_signed','sweep_pending','completed','review','dust'] as const;
const integer=z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n);
const filters=z.object({chain:z.enum(sweepChains).optional(),status:z.enum(statuses).optional(),asset:z.string().max(32).optional(),
  q:z.string().trim().max(128).default(''),before:integer.optional(),limit:z.coerce.number().int().min(1).max(50).default(25)}).strict();
const waitingFrom=`from custody_sweep_credits v join custody_sweep_networks n on n.chain_id=v.chain_id
  join deposits d on d.id=v.deposit_id join users u on u.id=d.user_id join assets a on a.id=v.asset_id
  where not exists(select 1 from custody_sweep_jobs j where j.deposit_id=v.deposit_id)`;
const waitingReason=`case when v.amount<v.minimum then 'below_minimum' when not v.route_enabled then 'route_disabled'
  when not v.key_ready then 'worker_unavailable' when n.destination is null then 'destination_missing'
  when not n.sweeps_enabled then 'sweeps_paused' else 'ready' end`;
const jobColumns=`j.id::text,j.deposit_id::text,j.chain_id,j.asset_id,a.symbol,a.decimals,j.amount::text,j.source,j.destination,j.sponsor,
  j.status,j.last_error,j.created_at,j.updated_at,j.completed_at,j.next_check_at,j.required_conf,j.finality_conf,
  j.deposit_txid,j.deposit_index,j.deposit_block::text,j.deposit_block_hash,u.id as user_id,u.username,
  s.amount::text as collection_amount,s.txid as collection_txid,
  (select coalesce(sum(fee),0)::text from custody_sweep_steps f where f.job_id=j.id) as fee_reserved,
  (select sum(actual_fee)::text from custody_sweep_steps f where f.job_id=j.id) as fee_recorded,
  (select count(*)::int from custody_sweep_steps f where f.job_id=j.id and f.finalized_at is not null and f.actual_fee is null) as missing_fee_receipts`;
const jobFrom=`from custody_sweep_jobs j join assets a on a.id=j.asset_id join deposit_addresses da on da.id=j.address_id
  join users u on u.id=da.user_id left join custody_sweep_steps s on s.job_id=j.id and s.phase='sweep'`;

export async function sweepAdminRoutes(app:FastifyInstance){
  app.addHook('preHandler',requireAdmin);
  app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store');});
  app.get('/api/admin/sweeps',async()=>tx(async c=>{
    await c.query('set transaction isolation level repeatable read read only');
    const counts=(await c.query(`select status,count(*)::text as count from custody_sweep_jobs group by status`)).rows;
    const amounts=(await c.query(`select j.chain_id,j.asset_id,a.symbol,a.decimals,count(*)::text as jobs,
      coalesce(sum(j.amount) filter(where j.status not in ('completed','dust')),0)::text as outstanding,
      coalesce(sum(s.amount) filter(where j.status='completed'),0)::text as collected,
      coalesce(sum(j.amount) filter(where j.status='review'),0)::text as review_amount,
      coalesce(sum(j.amount) filter(where j.status='dust'),0)::text as dust_amount
      from custody_sweep_jobs j join assets a on a.id=j.asset_id
      left join custody_sweep_steps s on s.job_id=j.id and s.phase='sweep'
      group by j.chain_id,j.asset_id,a.symbol,a.decimals order by j.chain_id,j.asset_id`)).rows;
    const awaiting=(await c.query(`select v.chain_id,v.asset_id,a.symbol,a.decimals,${waitingReason} as reason,
      count(*)::text as count,sum(v.amount)::text as amount ${waitingFrom}
      group by v.chain_id,v.asset_id,a.symbol,a.decimals,${waitingReason} order by v.chain_id,v.asset_id`)).rows;
    return {as_of:new Date().toISOString(),counts,amounts,awaiting};
  }));
  app.get('/api/admin/sweeps/fee-wallets',async()=>feeWalletReport());
  app.get('/api/admin/sweeps/jobs',async(req,reply)=>{
    const parsed=filters.safeParse(req.query);if(!parsed.success)return reply.code(400).send({error:'Invalid sweep filters'});
    const f=parsed.data;
    const rows=(await query(`select ${jobColumns} ${jobFrom}
      where ($1::text is null or j.chain_id=$1) and ($2::text is null or j.status=$2)
      and ($3::text is null or j.asset_id=$3) and ($4='' or position(lower($4) in lower(concat_ws(' ',j.id::text,u.username,
        j.source,j.destination,j.deposit_txid,(select string_agg(x.txid,' ') from custody_sweep_steps x where x.job_id=j.id))))>0)
      and ($5::bigint is null or j.id<$5) order by j.id desc limit $6`,
    [f.chain??null,f.status??null,f.asset??null,f.q,f.before??null,f.limit+1])).rows;
    const more=rows.length>f.limit,selected=rows.slice(0,f.limit);
    return {rows:selected,more,next_before:more?selected.at(-1)?.id:null};
  });
  app.get('/api/admin/sweeps/awaiting',async(req,reply)=>{
    const parsed=filters.omit({status:true}).safeParse(req.query);if(!parsed.success)return reply.code(400).send({error:'Invalid collection filters'});
    const f=parsed.data;
    const rows=(await query(`select v.deposit_id::text as id,v.chain_id,v.asset_id,a.symbol,a.decimals,v.amount::text,
      v.source,v.minimum::text,d.user_id,u.username,d.credited_at,d.txid,n.sweeps_enabled,n.destination,${waitingReason} as reason
      ${waitingFrom} and ($1::text is null or v.chain_id=$1) and ($2::text is null or v.asset_id=$2)
      and ($3='' or position(lower($3) in lower(concat_ws(' ',v.deposit_id::text,u.username,v.source,d.txid)))>0)
      and ($4::bigint is null or v.deposit_id<$4) order by v.deposit_id desc limit $5`,
    [f.chain??null,f.asset??null,f.q,f.before??null,f.limit+1])).rows;
    const more=rows.length>f.limit,selected=rows.slice(0,f.limit);
    return {rows:selected,more,next_before:more?selected.at(-1)?.id:null};
  });
  app.get('/api/admin/sweeps/jobs/:id',async(req,reply)=>{
    const parsed=z.object({id:integer}).safeParse(req.params);if(!parsed.success)return reply.code(400).send({error:'Invalid sweep job'});
    return tx(async c=>{
      await c.query('set transaction isolation level repeatable read read only');
      const job=(await c.query(`select ${jobColumns} ${jobFrom} where j.id=$1`,[parsed.data.id])).rows[0];
      if(!job)return reply.code(404).send({error:'Sweep job not found'});
      const steps=(await c.query(`select phase,txid,signer,amount::text,fee::text,actual_fee::text,nonce::text,
        last_valid_block_height::text,attempts,created_at,block_number::text,block_hash,finalized_at
        from custody_sweep_steps where job_id=$1 order by case when phase='sponsor' then 0 else 1 end`,[parsed.data.id])).rows;
      return {job,steps};
    });
  });
}
