import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { getAddress,ZeroAddress } from 'ethers';
import { z } from 'zod';
import { query,tx } from '../db.js';
import { decryptBlob,deleteSecret,setSecret } from '../vault.js';
import { ALCHEMY_KEY_SECRET, getRpcConfig, setRpcProviderAfterConfig } from '../chains/rpc.js';
import { totpStep } from '../authutil.js';
import { submitCustodyEnvelope } from '../derive.js';
import { validSolOwner } from '../chains/receive.js';
import { sweepChains } from '../custody/types.js';
import { depositSetup } from './routes-user.js';
import { requireAdmin } from './guards.js';

const factor=z.string().regex(/^\d{6}$/);
const rootInput=z.object({key_id:z.string().regex(/^[\da-f]{64}$/),sealed_base64:z.string().regex(/^[A-Za-z0-9+/]{512}$/),totp:factor}).strict();
const alchemyInput=z.object({totp:factor,api_key:z.union([z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/),z.null()])}).strict();
const alchemyAddInput=z.object({totp:factor,api_key:z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/)}).strict();
const alchemySlotInput=z.object({slot:z.coerce.number().int().min(1).max(10)}).strict();
const drpcInput=z.object({totp:factor,api_key:z.union([z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/),z.null()])}).strict();
const networkInput=z.object({totp:factor,destination:z.string().min(1).max(64).optional(),enabled:z.boolean().optional()}).strict();

async function useFactor(c:PoolClient,req:FastifyRequest,code:string){
  const id=req.admin!.adminId;
  const a=(await c.query('select totp_dek,totp_iv,totp_tag,totp_secret_enc from admin_users where id=$1 and totp_enabled and not disabled for share',[id])).rows[0];
  if(!a)return false;
  const secret=decryptBlob({enc_dek:a.totp_dek,iv:a.totp_iv,tag:a.totp_tag,ciphertext:a.totp_secret_enc});
  let step:number|null;try{step=totpStep(secret.toString(),code);}finally{secret.fill(0);}
  if(step===null)return false;
  return !!(await c.query('insert into custody_admin_challenges(admin_id,last_step) values($1,$2) on conflict(admin_id) do update set last_step=excluded.last_step where custody_admin_challenges.last_step<excluded.last_step',[id,step])).rowCount;
}
function record(c:PoolClient,req:FastifyRequest,action:string,detail:unknown){
  return c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',[req.admin!.username,action,detail,req.ip]);
}

export async function custodyAdminRoutes(app:FastifyInstance){
  app.addHook('preHandler',requireAdmin);
  app.addHook('preHandler',async(req,reply)=>{
    if(req.method==='GET'||!req.admin)return;
    const route=req.routeOptions.url!,limit=route.endsWith('/root')?10:15;
    const {rows:[row]}=await query(`insert into api_rate_limits(ip,route,window_start,hits) values($1,$2,clock_timestamp(),1)
      on conflict(ip,route) do update set
        hits=case when api_rate_limits.window_start<clock_timestamp()-interval '5 minutes' then 1 else least(api_rate_limits.hits+1,1000) end,
        window_start=case when api_rate_limits.window_start<clock_timestamp()-interval '5 minutes' then clock_timestamp() else api_rate_limits.window_start end
      returning hits`,['custody-admin:'+req.admin.adminId,route]);
    if(row.hits>limit)return reply.header('Retry-After','300').code(429).send({error:'Too many custody changes. Try again shortly.'});
  });
  app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store');});
  app.get('/api/admin/custody',async()=>{
    const [key,networks,assets,jobs,setup,alchemy,alchemyState,alchemySlots,drpc]=await Promise.all([
      query('select key_id as id,spki,configured,ready,fee_address from custody_public_key'),
      query(`select n.chain_id as id,c.display_name,c.required_conf,c.last_scanned,h.scan_ready,h.rpc_configured,h.ready,
        n.destination,n.sweeps_enabled,n.destination is not null as destination_locked,
        case when w.checked_at between clock_timestamp()-interval '2 minutes' and clock_timestamp() then w.status else 'offline' end as worker_status,
        w.last_error as worker_error,w.checked_at as worker_checked_at
        from custody_sweep_networks n join chains c on c.id=n.chain_id join custody_network_readiness h using(chain_id)
        left join custody_worker_health w using(chain_id) order by c.id`),
      query('select id,chain_id,symbol,kind,decimals,enabled,token_address,min_deposit::text from custody_launch_assets order by kind,id'),
      query(`select j.id,j.chain_id,j.asset_id,j.status,j.last_error,j.updated_at,
        (select s.txid from custody_sweep_steps s where s.job_id=j.id order by (s.phase='sweep') desc limit 1) as txid
        from custody_sweep_jobs j order by j.updated_at desc,j.id desc limit 50`),depositSetup(),
      query("select exists(select 1 from secrets where name like 'alchemy:API_KEY%') as configured"),
      query('select active_slot,active_provider,deposits_paused from alchemy_rpc_state where singleton'),
      query(`select h.slot,(select s.name from secrets s where s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end) is not null as configured,
        (select active_provider from alchemy_rpc_state where singleton)='alchemy' and
          h.slot=(select active_slot from alchemy_rpc_state where singleton) as active,
        h.cooldown_until>clock_timestamp() as cooling_down from alchemy_rpc_key_health h order by h.slot`),
      query("select exists(select 1 from secrets where name='drpc:API_KEY') as configured")]);
    const configuredSlots=alchemySlots.rows.filter(s=>s.configured);
    const routes=await Promise.all(networks.rows.map(async n=>{
      const endpoint=await getRpcConfig(n.id);
      return {...n,rpc_provider:endpoint?.provider??'unavailable',rpc_fallback_slot:endpoint?.alchemy?endpoint.slot:null};
    }));
    const providers=new Set(routes.map(n=>n.rpc_provider));
    const activeSlots=new Set(routes.map(n=>n.rpc_fallback_slot).filter(s=>s!==null));
    return {deposits_paused:setup.deposits_paused,alchemy_configured:alchemy.rows[0]?.configured===true,
      alchemy_key_count:configuredSlots.length,alchemy_active_slot:[...activeSlots][0]??0,
      alchemy_key_slots:configuredSlots.map(({slot,cooling_down})=>({slot,active:activeSlots.has(slot),cooling_down})),
      drpc_configured:drpc.rows[0]?.configured===true,provider_paused:alchemyState.rows[0]?.deposits_paused??false,
      rpc_provider:providers.size===1?routes[0]?.rpc_provider??'unavailable':'mixed',
      key:key.rows[0]??{id:null,spki:null,configured:false,ready:false,fee_address:null},
      networks:routes.map(n=>({...n,assets:assets.rows.filter(a=>a.chain_id===n.id)})),jobs:jobs.rows};
  });
  app.post('/api/admin/custody/root',async(req,reply)=>{
    const b=rootInput.safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Invalid sealed enrollment'});
    try{
      const saved=await tx(async c=>{if(!await useFactor(c,req,b.data.totp))return false;
        await submitCustodyEnvelope(c,b.data.key_id,b.data.sealed_base64);await record(c,req,'custody.enroll',{key_id:b.data.key_id});return true;});
      if(!saved)return reply.code(403).send({error:'A fresh authenticator code is required'});
      return {ok:true};
    }catch{return reply.code(409).send({error:'Enrollment unavailable. Refresh worker status before retrying.'});}
  });
  app.put('/api/admin/custody/alchemy',async(req,reply)=>{
    const b=alchemyInput.safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Invalid Alchemy API key settings'});
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,b.data.totp))return false;
        const networks=(await c.query(`select chain_id,sweeps_enabled from custody_sweep_networks
          where chain_id=any($1::text[]) order by chain_id for update`,[['ETH','BSC','POL','SOL']])).rows;
        if(networks.length!==4 || networks.some(n=>n.sweeps_enabled))throw new Error();
        await deleteSecret(ALCHEMY_KEY_SECRET(1),c);
        if(b.data.api_key!==null)await setSecret(ALCHEMY_KEY_SECRET(1),b.data.api_key,req.admin!.username,c);
        await c.query('update alchemy_rpc_key_health set cooldown_until=null,failures=0 where slot=1');
        const drpcConfigured=(await c.query("select exists(select 1 from secrets where name='drpc:API_KEY') as configured")).rows[0]?.configured;
        const alchemyCount=(await c.query("select count(*)::int as count from secrets where name like 'alchemy:API_KEY%'")).rows[0]?.count;
        const state=(await c.query<{active_provider:string}>('select active_provider from alchemy_rpc_state where singleton for update')).rows[0];
        const provider=state?.active_provider==='alchemy'&&alchemyCount?'alchemy':drpcConfigured?'drpc':alchemyCount?'alchemy':'legacy';
        await setRpcProviderAfterConfig(provider,c);
        await c.query("update chains set scan_ready_at=null,next_scan_at=null where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
        await record(c,req,'custody.alchemy_rpc',{configured:b.data.api_key!==null,key_count:b.data.api_key===null?0:1});
        return true;
      });
      if(!saved)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true};
      }catch{return reply.code(409).send({error:'Pause all network sweeps before changing Alchemy RPC settings.'});}
  });
  app.post('/api/admin/custody/alchemy/keys',async(req,reply)=>{
    const b=alchemyAddInput.safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Invalid Alchemy API key'});
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,b.data.totp))return {factor:false};
        const networks=(await c.query(`select chain_id,sweeps_enabled from custody_sweep_networks
          where chain_id=any($1::text[]) order by chain_id for update`,[['ETH','BSC','POL','SOL']])).rows;
        if(networks.length!==4||networks.some(n=>n.sweeps_enabled))throw new Error();
        const present=new Set((await c.query("select name from secrets where name like 'alchemy:API_KEY%'" )).rows.map(r=>r.name));
        const slot=Array.from({length:10},(_,i)=>i+1).find(n=>!present.has(ALCHEMY_KEY_SECRET(n)));
        if(!slot)throw new Error();
        const existing=(await c.query<{enc_dek:Buffer;iv:Buffer;tag:Buffer;ciphertext:Buffer}>(`select enc_dek,iv,tag,ciphertext from secrets where name like 'alchemy:API_KEY%'`)).rows;
        for(const blob of existing){const value=decryptBlob(blob);const duplicate=value.toString('utf8')===b.data.api_key;value.fill(0);if(duplicate)throw new Error();}
        await setSecret(ALCHEMY_KEY_SECRET(slot),b.data.api_key,req.admin!.username,c);
        const state=(await c.query<{active_slot:number;active_provider:string}>('select active_slot,active_provider from alchemy_rpc_state where singleton for update')).rows[0];
        await c.query('update alchemy_rpc_key_health set cooldown_until=null,failures=0 where slot=$1',[slot]);
        const drpcConfigured=(await c.query("select exists(select 1 from secrets where name='drpc:API_KEY') as configured")).rows[0]?.configured;
        const provider=state?.active_provider==='alchemy'?'alchemy':drpcConfigured?'drpc':'alchemy';
        await c.query('update alchemy_rpc_state set active_slot=$1,active_provider=$2,deposits_paused=true,changed_at=clock_timestamp(),routing_epoch=routing_epoch+1 where singleton',
          [provider==='alchemy'?(state?.active_slot||slot):(state?.active_slot??0),provider]);
        await c.query("update chains set scan_ready_at=null,next_scan_at=null where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
        await record(c,req,'custody.alchemy_key_add',{slot,key_count:present.size+1});
        return {factor:true,slot,count:present.size+1};
      });
      if(!saved.factor)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true,slot:saved.slot,key_count:saved.count};
    }catch{return reply.code(409).send({error:'Could not add an Alchemy key. Pause all network sweeps and keep at most ten keys.'});}
  });
  app.delete('/api/admin/custody/alchemy/keys/:slot',async(req,reply)=>{
    const p=alchemySlotInput.safeParse(req.params),b=z.object({totp:factor}).strict().safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'Invalid Alchemy key slot'});
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,b.data.totp))return false;
        const networks=(await c.query(`select chain_id,sweeps_enabled from custody_sweep_networks
          where chain_id=any($1::text[]) order by chain_id for update`,[['ETH','BSC','POL','SOL']])).rows;
        if(networks.length!==4||networks.some(n=>n.sweeps_enabled))throw new Error();
        const slot=p.data.slot;
        const removed=await c.query('delete from secrets where name=$1',[ALCHEMY_KEY_SECRET(slot)]);
        if(!removed.rowCount)throw new Error();
        const remaining=(await c.query<{slot:number}>(`select h.slot from alchemy_rpc_key_health h where exists(
          select 1 from secrets s where s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end)
          order by h.slot`)).rows;
        const state=(await c.query<{active_slot:number;active_provider:string}>('select active_slot,active_provider from alchemy_rpc_state where singleton for update')).rows[0];
        const drpcConfigured=(await c.query("select exists(select 1 from secrets where name='drpc:API_KEY') as configured")).rows[0]?.configured;
        const previous=state?.active_slot??0;
        const healthy=(await c.query<{slot:number}>(`select h.slot from alchemy_rpc_key_health h where
          (h.cooldown_until is null or h.cooldown_until<=clock_timestamp()) and exists(select 1 from secrets s where
            s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end)
          order by ((h.slot-$1+10)%10) limit 1`,[previous])).rows[0]?.slot??0;
        const provider=state?.active_provider==='alchemy'&&remaining.length?'alchemy':drpcConfigured?'drpc':remaining.length?'alchemy':'legacy';
        await c.query('update alchemy_rpc_key_health set cooldown_until=null,failures=0 where slot=$1',[slot]);
        await c.query(`update alchemy_rpc_state set active_slot=$1,active_provider=$2,deposits_paused=true,
          changed_at=clock_timestamp(),routing_epoch=routing_epoch+1 where singleton`,[healthy,provider]);
        await c.query("update chains set scan_ready_at=null,next_scan_at=null where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
        await record(c,req,'custody.alchemy_key_remove',{slot,key_count:remaining.length});return true;
      });
      if(!saved)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true};
    }catch{return reply.code(409).send({error:'Could not remove this Alchemy key. Pause all network sweeps first.'});}
  });
  app.put('/api/admin/custody/drpc',async(req,reply)=>{
    const b=drpcInput.safeParse(req.body);if(!b.success)return reply.code(400).send({error:'Invalid dRPC API key settings'});
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,b.data.totp))return false;
        const networks=(await c.query(`select chain_id,sweeps_enabled from custody_sweep_networks
          where chain_id=any($1::text[]) order by chain_id for update`,[['ETH','BSC','POL','SOL']])).rows;
        if(networks.length!==4||networks.some(n=>n.sweeps_enabled))throw new Error();
        if(b.data.api_key===null)await deleteSecret('drpc:API_KEY',c);
        else await setSecret('drpc:API_KEY',b.data.api_key,req.admin!.username,c);
        const alchemy=(await c.query("select exists(select 1 from secrets where name like 'alchemy:API_KEY%') as configured")).rows[0]?.configured;
        await setRpcProviderAfterConfig(b.data.api_key!==null?'drpc':alchemy?'alchemy':'legacy',c);
        await c.query("update chains set scan_ready_at=null,next_scan_at=null where id=any($1::text[])",[['ETH','BSC','POL','SOL']]);
        await record(c,req,'custody.drpc_rpc',{configured:b.data.api_key!==null});return true;
      });
      if(!saved)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true};
    }catch{return reply.code(409).send({error:'Pause all network sweeps before changing dRPC settings.'});}
  });
  app.put('/api/admin/custody/networks/:id',async(req,reply)=>{
    const p=z.object({id:z.enum(sweepChains)}).safeParse(req.params),b=networkInput.safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'Invalid network settings'});
    const {enabled,totp}=b.data,id=p.data.id;let dest=b.data.destination;
    if(dest===undefined&&enabled===undefined)return reply.code(400).send({error:'Save a collection address or update sweep status'});
    try{
      if(dest){if(id==='SOL'){if(!validSolOwner(dest))throw 0;}else{dest=getAddress(dest).toLowerCase();if(dest===ZeroAddress)throw 0;}}
    }catch{return reply.code(400).send({error:'Check the public collection address'});}
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,totp))return false;
        const n=(await c.query('select destination,sweeps_enabled from custody_sweep_networks where chain_id=$1 for update',[id])).rows[0];
        if(!n || (dest&&n.destination&&n.destination!==dest))throw new Error();
        if(n.sweeps_enabled && dest!==undefined)throw new Error();
        if(dest){
          const invalid=await c.query(`select 1 from deposit_addresses where address=$1 union all select 1 from custody_sol_pool where address=$1
            union all select 1 from custody_public_key where fee_address=$1 union all select 1 from assets where lower(token_address)=lower($1) limit 1`,[dest]);
          if(invalid.rowCount)throw new Error();
        }
        if(enabled===true){const ready=(await c.query('select ready from custody_network_readiness where chain_id=$1',[id])).rows[0]?.ready;
          if(!ready||!n.destination||dest!==n.destination)throw new Error();}
        await c.query('update custody_sweep_networks set destination=coalesce($2,destination),sweeps_enabled=coalesce($3,sweeps_enabled) where chain_id=$1',[id,dest??null,enabled??null]);
        await record(c,req,'custody.network',{chain:id,destination:dest??null,enabled:enabled??null});return true;
      });
      if(!saved)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true};
    }catch{return reply.code(409).send({error:'Network change unavailable. Verify worker, scanner and pinned collection address.'});}
  });
}
