import { query } from './db.js';
import { EvmWatcher } from './chains/evm.js';
import { NonEvmWatcher } from './chains/non-evm.js';
import { SolRpcUnavailable } from './chains/sol-rpc.js';
import { clearAlchemyPauseWhenReady } from './chains/rpc.js';
import { scanFailureReason } from './chains/scan-error.js';
import { scanIntervalMs } from './chains/scan-policy.js';

const running=new Map<string,{active:boolean}>();
export async function startWatchers():Promise<void>{
  const chains=(await query<{id:string;kind:string}>('select id,kind from chains where enabled')).rows;
  for(const [id,task] of running)if(!chains.some(c=>c.id===id)){task.active=false;running.delete(id);}
  for(const chain of chains){
    if(running.has(chain.id))continue;
    const watcher=chain.kind==='evm'?new EvmWatcher(chain.id,true):new NonEvmWatcher(chain.id,true);
    const task={active:true};running.set(chain.id,task);
    const loop=async()=>{
      let failures=0;
      while(task.active){
        let delay=scanIntervalMs(chain.id);
        try{await watcher.tick();await clearAlchemyPauseWhenReady();failures=0;if(watcher.needsCatchUp)delay=1000;}
        catch(error){
          failures++;
          delay=Math.max(delay,Math.min(60000,1000*2**Math.min(failures,6)),error instanceof SolRpcUnavailable?error.retryAfterMs:0);
          console.error('[watcher %s] scan unavailable; committed progress retained; reason=%s',chain.id,scanFailureReason(error));
        }
        // Long provider cooldowns are respected without overflowing Node's timer.
        await new Promise(resolve=>setTimeout(resolve,Math.min(delay,2147483647)));
      }
    };
    void loop();
  }
}
export function stopWatchers():void{for(const task of running.values())task.active=false;running.clear();}
export function superviseWatchers():void{
  setInterval(()=>{void startWatchers().catch(()=>console.error('Watcher supervision unavailable'));},60000);
}
