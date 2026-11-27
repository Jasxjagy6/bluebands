import type { PoolClient } from 'pg';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { pool, query, tx } from '../db.js';
import { decryptBlob, getSecret } from '../vault.js';

const alchemyNetworks: Record<string, string> = {
  ETH: 'eth-mainnet', BSC: 'bnb-mainnet', POL: 'polygon-mainnet', SOL: 'solana-mainnet',
};
const drpcNetworks: Record<string, string> = { ETH: 'ethereum', BSC: 'bsc', POL: 'polygon', SOL: 'solana' };
const apiKeyPattern = /^[\x21-\x7E]{8,128}$/;
const secretName = (slot: number) => slot === 1 ? 'alchemy:API_KEY' : `alchemy:API_KEY:${slot}`;
// Keep one conservative account-wide allowance across replicas and all keys.
// The shared 60-CU burst plus 120-CU/s refill stays below the documented cap.
const CAPACITY = 60, REFILL_PER_SECOND = 120;
const cu: Record<string, number> = {
  eth_chainId: 5, eth_blockNumber: 10, eth_getBlockByNumber: 20, eth_getBlockByHash: 20,
  eth_getLogs: 60, eth_getTransactionReceipt: 20, eth_getTransactionByHash: 20,
  eth_getTransactionCount: 20, eth_getBalance: 20, eth_getCode: 20, eth_call: 26,
  eth_estimateGas: 20, eth_gasPrice: 20, eth_feeHistory: 10, eth_sendRawTransaction: 50,
  getGenesisHash: 10, getSlot: 20, getBlocks: 10, getBlock: 40, getSignaturesForAddress: 40,
  getTransaction: 40, getSignatureStatuses: 20, getFirstAvailableBlock: 40,
  minimumLedgerSlot: 20, getMultipleAccounts: 20, getMinimumBalanceForRentExemption: 10,
  getFeeForMessage: 20, sendTransaction: 20, getLatestBlockhash: 20, getBlockHeight: 20,
  isBlockhashValid: 20, getAccountInfo: 10, getBalance: 10,
};

export type RpcEndpoint = { url: string; provider: 'drpc'|'alchemy'|'legacy'; alchemy: boolean; slot: number | null; epoch: string|null; chainId: string;
  deferFailures?: boolean; deferredFailure?: ProviderFailure };
type ProviderFailure = 'throttle'|'credential'|'unavailable'|'unsupported';

export function alchemyRpcUrl(chainId: string, apiKey: string): string {
  const network = alchemyNetworks[chainId];
  if (!network || !apiKeyPattern.test(apiKey) || apiKey === '.' || apiKey === '..')
    throw new Error('Alchemy RPC configuration unavailable');
  return `https://${network}.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`;
}

export function drpcRpcUrl(chainId: string, apiKey: string): string {
  const network=drpcNetworks[chainId];
  if(!network||!apiKeyPattern.test(apiKey)||apiKey==='.'||apiKey==='..')throw new Error('dRPC configuration unavailable');
  return `https://lb.drpc.live/${network}/${encodeURIComponent(apiKey)}`;
}

function rpcCost(body: unknown): number {
  const payloads = Array.isArray(body) ? body : [body];
  return Math.max(1, payloads.reduce((sum, item: any) => sum + (cu[String(item?.method)] ?? 60), 0));
}

/** Distributed token bucket shared by all replicas and all pooled keys. */
export async function reserveAlchemyCu(cost: number): Promise<void> {
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > CAPACITY) throw new Error('Alchemy request exceeds the configured throughput budget');
  await reserveRpcBudget('alchemy_rpc_budget',cost,CAPACITY,REFILL_PER_SECOND);
}

export async function reserveDrpcRequest():Promise<void>{
  await reserveRpcBudget('drpc_rpc_budget',1,1,4);
}

async function reserveRpcBudget(table:'alchemy_rpc_budget'|'drpc_rpc_budget',cost:number,capacity:number,refill:number):Promise<void>{
  for (;;) {
    const { rows: [row] } = await pool.rpcBudget.query<{ wait_ms: number }>(`
      with locked as materialized (
        select singleton,tokens,updated_at from ${table} where singleton for update
      ), stamp as materialized (select clock_timestamp() as at from locked), available as (
        select b.singleton, s.at, least($2::numeric, greatest(0,
          b.tokens + extract(epoch from (s.at-b.updated_at))*$3::numeric)) as tokens
        from locked b cross join stamp s
      )
      update ${table} b set
        tokens=case when a.tokens >= $1 then a.tokens-$1 else a.tokens end,
        updated_at=a.at
      from available a where b.singleton=a.singleton
      returning case when a.tokens >= $1 then 0 else ceil((($1-a.tokens)/$3::numeric)*1000)::integer end as wait_ms`,
    [cost, capacity, refill]);
    if (!row) throw new Error('RPC throughput budget unavailable');
    if (row.wait_ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(row.wait_ms, 1000)));
  }
}

function cooldownFor(kind: 'throttle' | 'credential' | 'unavailable'): number {
  return kind === 'credential' ? 5 * 60_000 : kind === 'throttle' ? 15_000 : 10_000;
}

/** A failing key is cooled down once; concurrent stale failures cannot skip active keys. */
export async function rotateAlchemyKey(slot: number, kind: 'throttle' | 'credential' | 'unavailable'): Promise<boolean> {
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 10) return false;
  return tx(async c => {
    const state = (await c.query<{active_slot:number}>('select active_slot from alchemy_rpc_state where singleton for update')).rows[0];
    await c.query(`update alchemy_rpc_key_health set cooldown_until=greatest(coalesce(cooldown_until,clock_timestamp()),
      clock_timestamp()+($2::integer*interval '1 millisecond')),failures=failures+1 where slot=$1`, [slot, cooldownFor(kind)]);
    if (!state || (state.active_slot !== slot && state.active_slot !== 0)) return false;
    const configured = (await c.query<{slot:number}>(`select h.slot from alchemy_rpc_key_health h
      where h.slot<>$1 and (h.cooldown_until is null or h.cooldown_until<=clock_timestamp())
        and exists(select 1 from secrets s where s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end)
      order by ((h.slot-$1+10)%10) limit 1`, [slot])).rows[0];
    await c.query(`update alchemy_rpc_state set active_slot=$1,deposits_paused=true,changed_at=clock_timestamp(),routing_epoch=routing_epoch+1 where singleton`, [configured?.slot ?? 0]);
    await c.query(`insert into audit_log(actor,action,detail) values('system','custody.alchemy_failover',$1)`,
      [{ from_slot: slot, to_slot: configured?.slot ?? null, reason: kind }]);
    return true;
  });
}

async function selectAvailableSlot(slot: number,db:Pick<PoolClient,'query'>=pool): Promise<number | null> {
  const { rows: [row] } = await db.query<{slot:number}>(`select h.slot from alchemy_rpc_key_health h
    where (h.cooldown_until is null or h.cooldown_until<=clock_timestamp())
      and exists(select 1 from secrets s where s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end)
    order by ((h.slot-$1+10)%10) limit 1`, [slot]);
  return row?.slot ?? null;
}

export async function getRpcConfig(chainId: string, db?: Pick<PoolClient, 'query'>): Promise<RpcEndpoint | null> {
  if (alchemyNetworks[chainId]) {
    const q = db ?? pool;
    const state = (await q.query<{active_slot:number;drpc_cooling:boolean;recovering:boolean;routing_epoch:string}>(`select s.active_slot,
      coalesce(h.cooldown_until>clock_timestamp(),false) as drpc_cooling,
      coalesce(h.last_error='throttle' and c.scan_ready_at is null,false) as recovering,
      s.routing_epoch::text from alchemy_rpc_state s
      left join drpc_rpc_chain_health h on h.chain_id=$1 left join chains c on c.id=h.chain_id where s.singleton`,[chainId])).rows[0];
    const drpc = (await q.query<{enc_dek:Buffer;iv:Buffer;tag:Buffer;ciphertext:Buffer}>(
      "select enc_dek,iv,tag,ciphertext from secrets where name='drpc:API_KEY'")).rows[0];
    const hasPool = (await q.query<{configured:boolean}>(`select exists(select 1 from secrets where name like 'alchemy:API_KEY%') as configured`)).rows[0]?.configured;
    // Solana is deliberately routed directly to Alchemy: this deployment's
    // dRPC plan does not include Solana. Scanners and signers share this policy.
    const primary=():RpcEndpoint|null=>chainId!=='SOL'&&drpc&&!state?.drpc_cooling?
      {url:drpcRpcUrl(chainId,decryptBlob(drpc).toString('utf8')),provider:'drpc',alchemy:false,slot:null,
        epoch:state?.routing_epoch??null,chainId,deferFailures:!!db}:null;
    // Once throttled, finish recovery on fallback before retrying the primary.
    // Retrying midway through each batch wastes both providers' allowances.
    if(!hasPool||!state?.recovering){const endpoint=primary();if(endpoint)return endpoint;}
    if (hasPool) {
      let slot = state?.active_slot ?? 1;
      if (!slot) {
        const available = await selectAvailableSlot(1,q);
        if (!available) return primary();
        slot = available;
      }
      const rows = (await q.query<{name:string;enc_dek:Buffer;iv:Buffer;tag:Buffer;ciphertext:Buffer}>(
        'select name,enc_dek,iv,tag,ciphertext from secrets where name=$1', [secretName(slot)])).rows;
      if (rows[0]) {
        const health = (await q.query<{cooldown:boolean}>('select coalesce(cooldown_until>clock_timestamp(),false) as cooldown from alchemy_rpc_key_health where slot=$1',[slot])).rows[0];
        if (!health?.cooldown) {
          const apiKey = decryptBlob(rows[0]).toString('utf8');
          return { url: alchemyRpcUrl(chainId, apiKey), provider:'alchemy', alchemy: true, slot,epoch:state?.routing_epoch??null,chainId,deferFailures:!!db };
        }
      }
      return primary();
    }
    // Do not silently bypass a configured provider's circuit breaker through a
    // stale per-network endpoint. Legacy RPCs are only a migration fallback.
    if (drpc || hasPool) return null;
    // Keep existing per-network endpoints available during migration, and
    // carry the routing epoch so an old in-flight scan cannot restore readiness.
    const url = await getSecret('rpc:' + chainId, db);
    return url ? { url, provider:'legacy', alchemy: false, slot: null,epoch:state?.routing_epoch??null,chainId } : null;
  }
  const url = await getSecret('rpc:' + chainId, db);
  return url ? { url, provider:'legacy', alchemy: false, slot: null,epoch:null,chainId } : null;
}

export async function getRpcEndpoint(chainId: string, db?: Pick<PoolClient, 'query'>): Promise<string | null> {
  return (await getRpcConfig(chainId, db))?.url ?? null;
}

/** Resume address issuance only after every enabled Alchemy-backed chain has a fresh checkpoint. */
export async function clearAlchemyPauseWhenReady(): Promise<void> {
  await query(`update alchemy_rpc_state s set deposits_paused=false
    where s.singleton and s.deposits_paused
      and exists(select 1 from chains c where c.enabled and c.id=any($1::text[]))
      and not exists(select 1 from chains c where c.enabled and c.id=any($1::text[]) and
        (c.scan_ready_at is null or c.scan_ready_at<=s.changed_at or c.scan_ready_at<clock_timestamp()-interval '2 minutes'))`,
  [['ETH','BSC','POL','SOL']]);
}

export async function failoverDrpc(chainId: string, kind: ProviderFailure = 'unavailable'): Promise<boolean> {
  if(!drpcNetworks[chainId])return false;
  return tx(async c=>{
    await c.query('select singleton from alchemy_rpc_state where singleton for update');
    const state=(await c.query<{cooling:boolean;failures:number}>(`select coalesce(cooldown_until>clock_timestamp(),false) as cooling,failures
      from drpc_rpc_chain_health where chain_id=$1 for update`,[chainId])).rows[0];
    if(!state||state.cooling)return false;
    const fallback=(await c.query<{slot:number}>(`select h.slot from alchemy_rpc_key_health h where
      (h.cooldown_until is null or h.cooldown_until<=clock_timestamp()) and exists(select 1 from secrets s where
        s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end)
      order by h.slot limit 1`)).rows[0];
    const anyAlchemy=(await c.query("select exists(select 1 from secrets where name like 'alchemy:API_KEY%') as configured")).rows[0]?.configured;
    // A free-plan throttle that persists across retries needs a quiet fallback
    // window. Constant primary retries otherwise discard whole scan batches.
    const throttleCooldown=Math.min(15*60_000,15_000*2**Math.min(state.failures,6));
    const cooldown=kind==='unsupported'?30*60_000:kind==='credential'?5*60_000:kind==='throttle'?throttleCooldown:30_000;
    await c.query(`update drpc_rpc_chain_health set cooldown_until=clock_timestamp()+($2::integer*interval '1 millisecond'),
      failures=failures+1,last_error=$3 where chain_id=$1`,[chainId,cooldown,kind]);
    await c.query(`update alchemy_rpc_state set active_slot=$1,deposits_paused=true,
      changed_at=clock_timestamp(),routing_epoch=routing_epoch+1 where singleton`,[fallback?.slot??0]);
    await c.query("insert into audit_log(actor,action,detail) values('system','custody.drpc_failover',$1)",
      [{chain_id:chainId,to_provider:anyAlchemy?'alchemy':null,reason:kind}]);
    return true;
  });
}

export async function setRpcProviderAfterConfig(provider:'drpc'|'alchemy'|'legacy',c:Pick<PoolClient,'query'>):Promise<void>{
  let slot=0;
  if(provider!=='legacy')slot=(await c.query<{slot:number}>(`select slot from alchemy_rpc_key_health h where exists(
    select 1 from secrets s where s.name=case when h.slot=1 then 'alchemy:API_KEY' else 'alchemy:API_KEY:'||h.slot::text end) order by slot limit 1`)).rows[0]?.slot??0;
  await c.query(`update alchemy_rpc_state set active_provider=$1,active_slot=$2,drpc_cooldown_until=null,
    deposits_paused=true,changed_at=clock_timestamp(),routing_epoch=routing_epoch+1 where singleton`,[provider,slot]);
  if(provider==='drpc')await c.query('update drpc_rpc_chain_health set cooldown_until=null,failures=0,last_error=null');
}

async function recordProviderFailure(endpoint: RpcEndpoint, kind: ProviderFailure): Promise<void> {
  // Scanners own a chain row while making RPC calls. Issuance owns the routing
  // row before locking that chain. Write routing changes only after the scan
  // transaction releases its locks, avoiding a cross-connection lock cycle.
  if(endpoint.deferFailures){endpoint.deferredFailure=kind;return;}
  if(endpoint.provider==='drpc')await failoverDrpc(endpoint.chainId,kind);
  else if(endpoint.provider==='alchemy')await rotateAlchemyKey(endpoint.slot!,kind==='unsupported'?'unavailable':kind);
}

export async function flushRpcFailure(endpoint: RpcEndpoint): Promise<void> {
  const kind=endpoint.deferredFailure;
  delete endpoint.deferredFailure;
  if(kind)await recordProviderFailure({...endpoint,deferFailures:false},kind);
}

async function inspectError(endpoint: RpcEndpoint, status: number, body: unknown): Promise<void> {
  let kind: 'throttle' | 'credential' | 'unavailable' | null = null;
  if (status === 429) kind = 'throttle';
  else if (status === 401 || status === 403) kind = 'credential';
  else if (status >= 500) kind = 'unavailable';
  else {
    const values = Array.isArray(body) ? body : [body];
    if (values.some((v: any) => v?.error?.code === 429 || /compute units per second|throughput capacity|rate limit|quota exceeded/i.test(String(v?.error?.message ?? '')))) kind = 'throttle';
  }
  if (kind) await recordProviderFailure(endpoint, kind);
}

function drpcProviderFailure(status:number,body:unknown):ProviderFailure|null{
  if(status===401||status===403)return 'credential';
  if(status===429)return 'throttle';
  if(status>=500)return 'unavailable';
  const values=Array.isArray(body)?body:[body];
  for(const v of values){
    if(!v||typeof v!=='object'||(!Object.hasOwn(v,'result')&&!Object.hasOwn(v,'error')))return 'unavailable';
    const message=String(v?.error?.message??'');
    if(v?.error?.code===35||v?.error?.code===-32601||/chain is not available|not (?:available|supported) on.*plan|upgrade.*paid plan/i.test(message))return 'unsupported';
    if(v?.error?.code===429||/rate limit|quota|capacity|throughput/i.test(message))return 'throttle';
    if(/invalid (?:api )?key|unauthorized|authentication|access denied/i.test(message))return 'credential';
    if(/temporarily unavailable|upstream|service unavailable|internal error|node timeout/i.test(message))return 'unavailable';
  }
  return null;
}

/** Fetch wrapper shared by Solana and custody sweep RPC clients. */
export function createAlchemyFetch(endpoint: RpcEndpoint): typeof fetch {
  if (endpoint.provider==='legacy') return fetch;
  return async (input, init) => {
    let body: unknown;
    try { body = JSON.parse(String(init?.body ?? 'null')); } catch { body = null; }
    if(endpoint.alchemy)await reserveAlchemyCu(rpcCost(body));
    else for(let n=0;n<(Array.isArray(body)?body.length:1);n++)await reserveDrpcRequest();
    try {
      const response = await fetch(input, init);
      let parsed: unknown = null;
      try { parsed = await response.clone().json(); } catch { /* caller validates the RPC body */ }
      if(endpoint.provider==='drpc'){
        const kind=drpcProviderFailure(response.status,parsed);
        if(kind)await recordProviderFailure(endpoint,kind);
      }else await inspectError(endpoint, response.status, parsed);
      return response;
    } catch (error) {
      if(!init?.signal?.aborted)await recordProviderFailure(endpoint,'unavailable').catch(()=>{});
      throw error;
    }
  };
}

export function createAlchemyEvmProvider(endpoint: RpcEndpoint): JsonRpcProvider {
  if (!endpoint.alchemy || endpoint.slot === null) {
    if(endpoint.provider==='legacy')return new JsonRpcProvider(endpoint.url,undefined,{cacheTimeout:-1});
    const request=new FetchRequest(endpoint.url),base=request.getUrlFunc;
    request.timeout=15_000;
    request.retryFunc=async()=>false;
    request.getUrlFunc=async(req,signal)=>{
      await reserveDrpcRequest();
      try{const response=await base(req,signal);let parsed:unknown=null;
        try{parsed=JSON.parse(Buffer.from(response.body??new Uint8Array()).toString('utf8'));}catch{}
        const kind=drpcProviderFailure(response.statusCode,parsed);
        if(kind)await recordProviderFailure(endpoint,kind);
        return response;
      }catch(error){await recordProviderFailure(endpoint,'unavailable').catch(()=>{});throw error;}
    };
    return new JsonRpcProvider(request,undefined,{cacheTimeout:-1,batchMaxCount:1,staticNetwork:true});
  }
  const request = new FetchRequest(endpoint.url), base = request.getUrlFunc;
  request.timeout=15_000;
  request.retryFunc = async () => false;
  request.getUrlFunc = async (req, signal) => {
    let body: unknown;
    try { body = JSON.parse(Buffer.from(req.body ?? new Uint8Array()).toString('utf8')); } catch { body = null; }
    await reserveAlchemyCu(rpcCost(body));
    try {
      const response = await base(req, signal);
      let parsed: unknown = null;
      try { parsed = JSON.parse(Buffer.from(response.body??new Uint8Array()).toString('utf8')); } catch { /* ethers reports malformed JSON */ }
      await inspectError(endpoint, response.statusCode, parsed);
      return response;
    } catch (error) {
      await recordProviderFailure(endpoint, 'unavailable').catch(() => {});
      throw error;
    }
  };
  return new JsonRpcProvider(request, undefined, { cacheTimeout: -1,batchMaxCount:1,staticNetwork:true });
}

export const ALCHEMY_KEY_SECRET = secretName;
