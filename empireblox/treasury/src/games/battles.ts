import { lockActivePlayer } from '../auth-user.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, tx } from '../db.js';
import { floats, hashSeed, newServerSeed } from '../fair.js';
import { pickItem } from './catalog.js';
import { checkedQuote } from './prices.js';
import { debitStake, creditPayout } from '../bet.js';
import { post } from '../ledger.js';

export const teams:Record<string,number[][]>={'1v1':[[0],[1]],'3way':[[0],[1],[2]],'4way':[[0],[1],[2],[3]],
  '2v2':[[0,1],[2,3]],'3v3':[[0,1,2],[3,4,5]],'2v2v2':[[0,1],[2,3],[4,5]],g2:[[0,1]],g3:[[0,1,2]],g4:[[0,1,2,3]]};
type Setup={mode:string; cases:string[]; asset:string; quote:string; request:string; crazy:boolean; jackpot:boolean; borrow:number};
type Row={id:string;creator:string;mode:string;cost:number;asset_id:string;unit:string;seats:(string|null)[];borrow:number[];
  case_ids:string[];crazy:boolean;jackpot:boolean;status:string;pf_seed:string};
const fee=(cost:number,pct:number,unit:string|bigint)=>((BigInt(cost)*BigInt(100-pct)+99n)/100n)*BigInt(unit);

export async function createBattle(uid:string,b:Setup) {
  const groups=Object.hasOwn(teams,b.mode) && teams[b.mode];
  if(!groups) throw new Error('Choose a battle mode');
  return tx(async c=>{
    await lockActivePlayer(c,uid);
    const prior=(await c.query('select id from battles where creator=$1 and request=$2',[uid,b.request])).rows[0];
    if(prior) return prior;
    const price=await checkedQuote(c,b.quote,b.asset), unit=BigInt(price.unit);
    const prices=(await c.query('select price from unnest($1::text[]) chosen(id) join cases using(id) where active',[b.cases])).rows;
    if(prices.length!==b.cases.length) throw new Error('Case unavailable');
    const cost=prices.reduce((sum,n)=>sum+n.price,0), id=randomUUID(), seed=newServerSeed();
    const seats=Array(groups.flat().length).fill(null), borrow=seats.map(()=>0);
    seats[0]=uid;borrow[0]=b.borrow;
    await debitStake(c,uid,b.asset,fee(cost,b.borrow,unit),'battles',id,{quote:b.quote});
    await c.query(`insert into battles(id,creator,request,asset_id,unit,cost,mode,case_ids,seats,crazy,jackpot,borrow,pf_seed,pf_hash,minor_per_usd)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id,uid,b.request,b.asset,unit.toString(),cost,b.mode,b.cases,seats,groups.length>1&&b.crazy,groups.length>1&&b.jackpot,borrow,seed,hashSeed(seed),price.minor_per_usd]);
    return {id};
  });
}
async function settle(c:PoolClient,b:Row) {
  const groups=teams[b.mode]!;
  const items=(await c.query<{case_id:string;idx:number;value:string;weight:number;name:string}>(
    'select case_id,idx,value,weight,name from case_items where case_id=any($1) order by idx',[b.case_ids])).rows;
  const cases=b.case_ids.map(id=>items.filter(i=>i.case_id===id));
  const random=floats(b.pf_seed,b.id,0,b.seats.length*cases.length+1);
  let index=0;
  const pulls=b.seats.map(()=>cases.map(items=>pickItem(items,random[index++]!)));
  const totals=groups.map(group=>group.reduce((s,seat)=>s+pulls[seat]!.reduce((n,item)=>n+Number(item.value),0),0));
  const pot=totals.reduce((s,v)=>s+v,0);
  let jackpot:null|{roll:number;team:number}=null;
  let winning:number[];
  if(b.jackpot && groups.length>1){
    const roll=random[index]!;
    const weights=totals.map(t=>b.crazy?pot-t:t), sum=weights.reduce((a,v)=>a+v,0);
    let target=roll*sum;
    let team=weights.findIndex(v=>(target-=v)<0);
    if(team<0) team=Math.floor(roll*groups.length);
    jackpot={roll,team}; winning=groups[team]!;
  }else{
    const best=b.crazy?Math.min(...totals):Math.max(...totals);
    winning=groups.flatMap((g,i)=>totals[i]===best?g:[]);
  }
  const share=BigInt(pot)/BigInt(winning.length);
  const payouts=b.seats.map((_,i)=>winning.includes(i)?Number(share*BigInt(100-b.borrow[i]!)/100n):0);
  for(const [i,uid] of b.seats.entries()){
    if(uid && !uid.startsWith('bot:')) await c.query(`update users set catalog_wagered=catalog_wagered+
      coalesce((select catalog_xp from valued_debits where user_id=$1 and game='battles' and round_id=$2),$3::numeric) where id=$1`,
      [uid,b.id,(fee(b.cost,b.borrow[i]!,b.unit)/BigInt(b.unit)).toString()]);
    if(uid && !uid.startsWith('bot:') && payouts[i]) await creditPayout(c,uid,b.asset_id,BigInt(payouts[i]!)*BigInt(b.unit),'battles',b.id);
  }
  await c.query(`update battles set results=$2,payouts=$3,jp=$4,status='rolling',started_at=now()+interval '3 seconds' where id=$1`,
    [b.id,JSON.stringify(pulls.map(seat=>seat.map(i=>i.idx))),JSON.stringify(payouts),jackpot]);
}
export async function battleAction(uid:string,id:string,action:'join'|'bots'|'cancel',seat:number|null,borrow:number,asset?:string) {
  return tx(async c=>{
    await lockActivePlayer(c,uid);
    const b=(await c.query<Row>('select * from battles where id=$1 for update',[id])).rows[0];
    if(!b || b.status!=='open') throw new Error('Battle is no longer open');
    if(action!=='join' && uid!==b.creator) throw new Error('Only the creator can do that');
    if(action==='cancel'){
      // Refund the actual debited stake for each human seat in the original asset.
      for(const [i,owner] of b.seats.entries()) if(owner && !owner.startsWith('bot:')){
        const amount=fee(b.cost,b.borrow[i]!,b.unit);
        await post(c,'refund:battles',id,[{account:'house:bank',asset:b.asset_id,delta:-amount},{account:'u:'+owner,asset:b.asset_id,delta:amount}]);
      }
      await c.query("update battles set status='cancelled' where id=$1",[id]); return {id};
    }
    if(seat!==null && (seat<0 || seat>=b.seats.length || b.seats[seat])) throw new Error('Seat unavailable');
    if(action==='join'){
      const currency=b.asset_id.startsWith('USDT.')?'USDT':b.asset_id;
      if(currency!==asset || seat===null || b.seats.includes(uid)) throw new Error('Cannot join this seat in the selected currency');
      await debitStake(c,uid,b.asset_id,fee(b.cost,borrow,b.unit),'battles',id);
      b.seats[seat]=uid;b.borrow[seat]=borrow;
    }else{
      const bots=['bot:1','bot:2','bot:3','bot:4','bot:5'].filter(x=>!b.seats.includes(x));
      b.seats=b.seats.map((owner,i)=>!owner && (seat===null||seat===i)?bots.shift()!:owner);
    }
    await c.query('update battles set seats=$2,borrow=$3 where id=$1',[id,b.seats,b.borrow]);
    if(b.seats.every(Boolean)) await settle(c,b);
    return {id};
  });
}
export async function listBattles(asset:string, uid?:string) {
  return (await query(`select b.id, creator,mode,case_ids,cost,seats,crazy,jackpot,borrow,status,
    case when a.symbol='USDT' then (unit*power(10::numeric,18-a.decimals))::numeric(78,0) else unit end as unit,
    case when a.symbol='USDT' then 'USDT' else asset_id end as asset_id,results,payouts,jp,pf_hash,
    case when status='rolling' then pf_seed end as pf_seed,b.created_at,started_at from battles b join assets a on a.id=b.asset_id
    where (asset_id=$1 or ($1='USDT' and a.symbol='USDT')) and (b.created_at >=now()-interval '7 days' or status='open' or $2=any(seats))
    order by (status='open' and $2=any(seats)) desc,b.created_at desc limit 100`,[asset,uid??null])).rows;
}
