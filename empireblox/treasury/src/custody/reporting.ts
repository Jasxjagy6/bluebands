import { query } from '../db.js';
import { createAlchemyFetch, getRpcConfig } from '../chains/rpc.js';
import { sweepFeeCeiling, dailySponsorCeilings } from './fee-policy.js';

const evmNetworks = {ETH:{network:1n,symbol:'ETH'},BSC:{network:56n,symbol:'BNB'},POL:{network:137n,symbol:'POL'}} as const;
type EvmChain=keyof typeof evmNetworks;
const uint=(value:unknown):bigint=>{
  if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value))throw Error('Invalid RPC quantity');
  return BigInt(value);
};

/** Refresh at most once a minute across replicas. Reporting cannot change routing or sign. */
export async function refreshFeeWallet(chain:EvmChain,address:string|null):Promise<void>{
  if(!address||!/^0x[\da-f]{40}$/i.test(address))return;
  const claim=await query(`update custody_fee_balances set attempted_at=clock_timestamp(),
    refresh_after=clock_timestamp()+interval '60 seconds'
    where chain_id=$1 and refresh_after<=clock_timestamp() returning chain_id`,[chain]);
  if(!claim.rowCount)return;
  try{
    const selected=await getRpcConfig(chain);if(!selected)throw Error('RPC not configured');
    // Balance reporting has no authority to pause address issuance on an RPC error.
    const endpoint={...selected,deferFailures:true},transport=createAlchemyFetch(endpoint);
    let sequence=0;
    const rpc=async(method:string,params:unknown[])=>{
      const id=++sequence;
      const response=await transport(endpoint.url,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok)throw Error('RPC unavailable');
      const body=await response.json() as {id?:number;jsonrpc?:string;result?:unknown;error?:unknown};
      if(body.id!==id||body.jsonrpc!=='2.0'||body.error||!Object.hasOwn(body,'result'))throw Error('RPC unavailable');
      return body.result;
    };
    if(uint(await rpc('eth_chainId',[]))!==evmNetworks[chain].network)throw Error('Wrong network');
    const block=await rpc('eth_getBlockByNumber',['latest',false]) as Record<string,unknown>|null;
    if(!block||typeof block.hash!=='string'||!/^0x[\da-f]{64}$/i.test(block.hash))throw Error('Missing canonical block');
    const height=uint(block.number),stamp=Number(uint(block.timestamp))*1000,now=Date.now();
    if(stamp<now-120000||stamp>now+30000)throw Error('Stale block');
    const balance=uint(await rpc('eth_getBalance',[address,{blockHash:block.hash,requireCanonical:true}]));
    await query(`update custody_fee_balances set address=$2,balance=$3,block_number=$4,block_hash=$5,
      checked_at=clock_timestamp(),last_error=null where chain_id=$1`,[chain,address,balance.toString(),height.toString(),block.hash]);
  }catch{
    // Preserve last known evidence and its timestamp. Unavailable never means zero.
    await query("update custody_fee_balances set last_error='unavailable' where chain_id=$1",[chain]);
  }
}

export async function feeWalletReport(){
  const address=(await query('select fee_address from custody_public_key where configured')).rows[0]?.fee_address??null;
  await Promise.all((Object.keys(evmNetworks) as EvmChain[]).map(chain=>refreshFeeWallet(chain,address)));
  const rows=(await query(`select n.chain_id,c.display_name,n.sweeps_enabled,n.destination,
    b.address,b.balance::text,b.block_number::text,b.block_hash,b.checked_at,b.attempted_at,b.refresh_after,b.last_error,
    (b.checked_at>=clock_timestamp()-interval '2 minutes') as fresh,
    case when w.checked_at>=clock_timestamp()-interval '2 minutes' then w.status else 'offline' end as worker_status,
    w.last_error as worker_error,w.checked_at as worker_checked_at,
    coalesce((select sum(s.amount+s.fee) from custody_sweep_steps s where s.chain_id=n.chain_id and s.phase='sponsor'
      and s.finalized_at>clock_timestamp()-interval '24 hours'),0)::text as sponsor_budget_used,
    coalesce((select sum(s.amount+s.fee) from custody_sweep_steps s where s.chain_id=n.chain_id and s.phase='sponsor'
      and s.finalized_at is null),0)::text as sponsor_budget_committed
    from custody_sweep_networks n join chains c on c.id=n.chain_id
    left join custody_fee_balances b on b.chain_id=n.chain_id left join custody_worker_health w on w.chain_id=n.chain_id
    order by n.chain_id`)).rows;
  return {checked_at:new Date().toISOString(),refresh_interval_seconds:60,wallets:rows.map(row=>{
    const chain=row.chain_id as keyof typeof sweepFeeCeiling,selfFunded=chain==='SOL';
    const sameAddress=row.address===address;
    return {...row,address:selfFunded?null:address,balance:sameAddress?row.balance:null,checked_at:sameAddress?row.checked_at:null,
      status:selfFunded?'self_funded':!address?'not_configured':sameAddress&&row.balance!==null&&row.fresh&&!row.last_error?'current':sameAddress&&row.balance!==null?'stale':'unavailable',
      symbol:selfFunded?'SOL':evmNetworks[chain as EvmChain].symbol,decimals:selfFunded?9:18,
      fee_ceiling:sweepFeeCeiling[chain].toString(),daily_sponsor_cap:selfFunded?null:(sweepFeeCeiling[chain]*dailySponsorCeilings).toString()};
  })};
}
