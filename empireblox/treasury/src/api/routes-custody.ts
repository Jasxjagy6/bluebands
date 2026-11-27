import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { getAddress,ZeroAddress } from 'ethers';
import { z } from 'zod';
import { query,tx } from '../db.js';
import { decryptBlob,setSecret } from '../vault.js';
import { totpStep } from '../authutil.js';
import { submitCustodyEnvelope } from '../derive.js';
import { validSolOwner } from '../chains/receive.js';
import { sweepChains } from '../custody/types.js';
import { depositSetup } from './routes-user.js';
import { requireAdmin } from './guards.js';

const factor=z.string().regex(/^\d{6}$/);
const rootInput=z.object({key_id:z.string().regex(/^[\da-f]{64}$/),sealed_base64:z.string().regex(/^[A-Za-z0-9+/]{512}$/),totp:factor}).strict();
const networkInput=z.object({totp:factor,rpc_url:z.string().min(1).max(2048).optional(),destination:z.string().min(1).max(64).optional(),enabled:z.boolean().optional()}).strict();

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
    const [key,networks,assets,jobs,setup]=await Promise.all([
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
        from custody_sweep_jobs j order by j.updated_at desc,j.id desc limit 50`),depositSetup()]);
    return {deposits_paused:setup.deposits_paused,key:key.rows[0]??{id:null,spki:null,configured:false,ready:false,fee_address:null},
      networks:networks.rows.map(n=>({...n,assets:assets.rows.filter(a=>a.chain_id===n.id)})),jobs:jobs.rows};
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
  app.put('/api/admin/custody/networks/:id',async(req,reply)=>{
    const p=z.object({id:z.enum(sweepChains)}).safeParse(req.params),b=networkInput.safeParse(req.body);
    if(!p.success||!b.success)return reply.code(400).send({error:'Invalid network settings'});
    const {rpc_url:url,enabled,totp}=b.data,id=p.data.id;let dest=b.data.destination;
    if((url===undefined&&dest===undefined&&enabled===undefined)||(url&&enabled===true))return reply.code(400).send({error:'Save the RPC and verify the scanner before activation'});
    try{if(url){const u=new URL(url);if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.hash||/[\s\\]/.test(url))throw 0;}
      if(dest){if(id==='SOL'){if(!validSolOwner(dest))throw 0;}else{dest=getAddress(dest).toLowerCase();if(dest===ZeroAddress)throw 0;}}
    }catch{return reply.code(400).send({error:'Check the HTTPS RPC URL and public collection address'});}
    try{
      const saved=await tx(async c=>{
        if(!await useFactor(c,req,totp))return false;
        const n=(await c.query('select destination,sweeps_enabled from custody_sweep_networks where chain_id=$1 for update',[id])).rows[0];
        if(!n || (dest&&n.destination&&n.destination!==dest))throw new Error();
        if(n.sweeps_enabled && (url!==undefined || dest!==undefined))throw new Error();
        if(dest){
          const invalid=await c.query(`select 1 from deposit_addresses where address=$1 union all select 1 from custody_sol_pool where address=$1
            union all select 1 from custody_public_key where fee_address=$1 union all select 1 from assets where lower(token_address)=lower($1) limit 1`,[dest]);
          if(invalid.rowCount)throw new Error();
        }
        if(url){await setSecret('rpc:'+id,url,req.admin!.username,c);await c.query('update chains set enabled=true,scan_ready_at=null where id=$1',[id]);}
        if(enabled===true){const ready=(await c.query('select ready from custody_network_readiness where chain_id=$1',[id])).rows[0]?.ready;
          if(!ready||!n.destination||dest!==n.destination)throw new Error();}
        await c.query('update custody_sweep_networks set destination=coalesce($2,destination),sweeps_enabled=coalesce($3,sweeps_enabled) where chain_id=$1',[id,dest??null,enabled??null]);
        await record(c,req,'custody.network',{chain:id,rpc_updated:!!url,destination:dest??null,enabled:enabled??null});return true;
      });
      if(!saved)return reply.code(403).send({error:'A new authenticator code is required'});
      return {ok:true};
    }catch{return reply.code(409).send({error:'Network change unavailable. Verify worker, scanner and pinned collection address.'});}
  });
}
