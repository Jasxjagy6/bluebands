import { tx } from './db.js';
import { getSecret } from './vault.js';
import { receiveAddress, supportedAssets } from './chains/receive.js';

/** Give each player one stable receive address per chain across both replicas. */
export async function getOrCreateAddress(userId:string,chainId:string){
  return tx(async c=>{
    const gates=await c.query(`select key,value from settings where key in ('deposit_provider','deposits_paused') order by key for share`);
    if(!gates.rows.some(s=>s.key==='deposit_provider' && s.value==='direct') || !gates.rows.some(s=>s.key==='deposits_paused' && s.value===false))throw new Error('Direct deposits unavailable');
    const chain=(await c.query<{kind:string;ready:boolean}>(`select n.kind,(n.enabled and scan_ready_at>now()-interval '2 minutes'
      and exists(select 1 from secrets where name='rpc:'||n.id)
      and (n.kind='sol' or exists(select 1 from secrets where name='xpub:'||n.id or (n.kind='evm' and name='xpub:EVM')))
      and exists(select 1 from assets a where a.chain_id=n.id and a.enabled and ${supportedAssets})
      and (select value from settings where key='deposits_paused')='false'::jsonb) as ready
      from chains n where id=$1 for share`,[chainId])).rows[0];
    if(!chain?.ready)throw new Error('Network unavailable');
    await c.query('select next_index from address_counters where chain_id=$1 for update',[chainId]);
    const previous=await c.query<{address:string}>('select address from deposit_addresses where user_id=$1 and chain_id=$2',[userId,chainId]);
    if(previous.rows[0])return {address:previous.rows[0].address,chainId};
    let address:string,index:number;
    if(chain.kind==='evm'){
      const xpub=(await getSecret('xpub:'+chainId,c))??await getSecret('xpub:EVM',c);
      if(!xpub)throw new Error('Missing deposit key');
      const allocated=await c.query(`insert into evm_receive_users(user_id,deriv_index) values($1,nextval('evm_receive_index'))
        on conflict(user_id) do update set user_id=excluded.user_id returning deriv_index`,[userId]);
      index=Number(allocated.rows[0].deriv_index);
      address=receiveAddress('evm',xpub,index);
    }else{
      const counter=await c.query('update address_counters set next_index=next_index+1 where chain_id=$1 returning next_index-1 as idx',[chainId]);
      index=Number(counter.rows[0].idx);
      if(chain.kind==='sol'){
        const row=await c.query(`update sol_receive_pool set user_id=$1 where address=(select address from sol_receive_pool
          where user_id is null order by imported_at,address limit 1 for update skip locked) returning address`,[userId]);
        if(!row.rows[0])throw new Error('No receiving addresses available');
        address=row.rows[0].address;
      }else{
        const xpub=await getSecret('xpub:'+chainId,c);
        if(!xpub)throw new Error('Missing deposit key');
        address=receiveAddress(chain.kind,xpub,index);
      }
    }
    await c.query('insert into deposit_addresses(user_id,chain_id,address,deriv_index) values($1,$2,$3,$4)',[userId,chainId,address,index]);
    return {address,chainId};
  });
}
