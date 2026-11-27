import { lockActivePlayer } from '../auth-user.js';
import { tx } from '../db.js';
import { floats } from '../fair.js';
import { parseAmount } from '../money.js';
import { takeGameSeed } from '../game-seeds.js';
import { debitStake, creditPayout } from '../bet.js';

import { checkedQuote } from './prices.js';
export { currentQuote,quoteUnit } from './prices.js';
type Item = {idx:number; value:string; weight:number; name:string};
export function pickItem(items:Item[], f:number) {
  let roll=f*items.reduce((sum,i)=>sum+i.weight,0);
  for(const item of items){roll-=item.weight;if(roll<0) return item;}
  throw new Error('Case catalog unavailable');
}
export type Instant = {game:'cases';case:string} | {game:'upgrader';item:number;bet:string;over:boolean} | {game:'rewards';level:number};
export async function instantRound(uid:string,asset:string,quote:string,request:string,action:Instant) {
  return tx(async c=>{
    await lockActivePlayer(c,uid);
    const prior=(await c.query('select result from instant_rounds where user_id=$1 and request=$2',[uid,request])).rows[0];
    if(prior) return prior.result;
    const price=await checkedQuote(c,quote,asset), unit=BigInt(price.unit);
    const seed=await takeGameSeed(c,uid);
    const f=floats(seed.server_seed,seed.client_seed,Number(seed.nonce),1)[0]!;
    let stake:bigint, payout:bigint, detail:Record<string,unknown>;
    if(action.game==='cases'){
      const box=(await c.query('select price from cases where id=$1 and active',[action.case])).rows[0];
      if(!box) throw new Error('Case unavailable');
      const items=(await c.query<Item>('select * from case_items where case_id=$1 order by idx',[action.case])).rows;
      const won=pickItem(items,f);
      stake=BigInt(box.price)*unit; payout=BigInt(won.value)*unit;
      detail={case:action.case,idx:won.idx,name:won.name,value:Number(won.value),price:box.price};
    }else if(action.game==='rewards'){
      const eligible=await c.query(`select 1 from reward_progress p join levels l on l.xp<=p.wagered
        where p.user_id=$1 and l.level=$2`,[uid,action.level]);
      if(!eligible.rowCount) throw new Error('Player level is too low');
      const claim=await c.query(`insert into reward_claims values($1,$2,now()) on conflict(user_id,level) do update set claimed_at=now()
        where reward_claims.claimed_at<=now()-interval '24 hours' returning claimed_at+interval '24 hours' as next_at`,[uid,action.level]);
      if(!claim.rowCount) throw new Error('Wait until your next reward is available');
      const items=(await c.query<Item>(`select p.idx,p.weight,i.value,i.name from reward_pack_items p join upgrade_items i on i.id=p.item_id where level=$1 order by idx`,[action.level])).rows;
      const won=pickItem(items,f); stake=0n;payout=BigInt(won.value)*unit;
      detail={level:action.level,idx:won.idx,value:Number(won.value),next_at:new Date(claim.rows[0].next_at).toISOString()};
    }else{
      const item=(await c.query('select name,value from upgrade_items where id=$1',[action.item])).rows[0];
      const a=(await c.query('select decimals from assets where id=$1',[asset])).rows[0]!;
      stake=parseAmount(action.bet,a.decimals);
      if(!item || stake<=0n || stake>=BigInt(item.value)*unit) throw new Error('Choose an item worth more than the stake');
      const threshold=stake*950000n/(BigInt(item.value)*unit);
      const chance=Number(threshold>800000n?800000n:threshold);
      const roll=Math.floor(f*1000000);
      const win=action.over ? roll>=1000000-chance : roll<chance;
      payout=win?BigInt(item.value)*unit:0n;
      detail={item:action.item,name:item.name,value:Number(item.value),over:action.over,roll:roll/10000,chance:chance/10000,win};
    }
    if(stake){
      const booked=await debitStake(c,uid,asset,stake,action.game,request,{quote});
      await c.query('update users set catalog_wagered=catalog_wagered+$2 where id=$1',[uid,booked.catalogXp.toString()]);
    }
    await creditPayout(c,uid,asset,payout,action.game,request);
    const result={...detail,asset_id:asset,stake:stake.toString(),payout:payout.toString(),seed_hash:seed.server_seed_hash};
    await c.query(`insert into instant_rounds(user_id,request,game,asset_id,result,server_seed,client_seed,nonce,minor_per_usd)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[uid,request,action.game,asset,result,seed.server_seed,seed.client_seed,seed.nonce,price.minor_per_usd]);
    if(action.game==='rewards')await c.query("select notify_player($1,'reward.pack_claimed',$2,$3,$4)",[uid,request,asset,payout.toString()]);
    return result;
  });
}
