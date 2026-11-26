import { query } from './db.js';
import { EvmWatcher } from './chains/evm.js';
import { NonEvmWatcher } from './chains/non-evm.js';

const running=new Map<string,{active:boolean}>();
export async function startWatchers():Promise<void>{
  const chains=(await query<{id:string;kind:string}>(`select c.id,c.kind from chains c where c.enabled and (
    (select value from settings where key='deposit_provider')='"direct"'::jsonb
    or exists(select 1 from deposit_addresses d where d.chain_id=c.id)
    or exists(select 1 from deposits d where d.chain_id=c.id and d.status in ('pending','confirmed')))`)).rows;
  for(const [id,task] of running)if(!chains.some(c=>c.id===id)){task.active=false;running.delete(id);}
  for(const chain of chains){
    if(running.has(chain.id))continue;
    const watcher=chain.kind==='evm'?new EvmWatcher(chain.id):new NonEvmWatcher(chain.id);
    const task={active:true};running.set(chain.id,task);
    const loop=async()=>{
      while(task.active){
        try{await watcher.tick();}
        catch{console.error('[watcher %s] scan unavailable; cursor retained',chain.id);}
        await new Promise(resolve=>setTimeout(resolve,chain.kind==='sol'?3000:12000));
      }
    };
    void loop();
  }
}
export function stopWatchers():void{for(const task of running.values())task.active=false;running.clear();}
export function superviseWatchers():void{
  setInterval(()=>{void startWatchers().catch(()=>console.error('Watcher supervision unavailable'));},60000);
}
