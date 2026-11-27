import type { PoolClient } from 'pg';
import { pool } from '../db.js';

/** The active program: 100 coin-wager levels and one daily pack per ten levels. */
export async function coinRewards(uid:string,db:Pick<PoolClient,'query'>=pool){
  const total=(await db.query(`select p.wagered::text,
    (select trim_scale(coalesce(sum(usd),0))::text from vip_wagers where user_id=$1) as wagered_usd,
    (select trim_scale(coalesce(sum(usdt),0))::text from vip_wagers where user_id=$1) as wagered_usdt,
    (select count(*)::int from vip_wagers where user_id=$1 and unpriced_usdt) as unpriced_usdt
    from reward_progress p where p.user_id=$1`,[uid])).rows[0];
  if(!total)throw new Error('Player unavailable');
  const levels=(await db.query('select level,xp::text,xp<=$1::numeric as earned from levels order by level',[total.wagered])).rows;
  const packs=(await db.query(`select p.level,p.name,l.xp::text as wager_required,c.claimed_at,c.claimed_at+interval '24 hours' as next_at,
    l.xp<=$2::numeric as earned,(l.xp<=$2::numeric and (c.claimed_at is null or c.claimed_at+interval '24 hours'<=clock_timestamp())) as ready
    from reward_packs p join levels l on l.level=p.level left join reward_claims c on c.level=p.level and c.user_id=$1 order by p.level`,[uid,total.wagered])).rows;
  const current=levels.filter(l=>l.earned).at(-1)??{level:1,xp:'0'},next=levels.find(l=>!l.earned);
  const wagered=BigInt(total.wagered),toNext=next?BigInt(next.xp)-wagered:0n;
  const progress=next?Number((wagered-BigInt(current.xp))*10000n/(BigInt(next.xp)-BigInt(current.xp)))/100:100;
  return {...total,level:current.level,next_level:next?.level??null,to_next:toNext.toString(),progress,
    packs,levels,claims:packs.filter(p=>p.claimed_at).map(({level,claimed_at})=>({level,claimed_at})),
    ready_count:packs.filter(p=>p.ready).length,program:'daily_coins'};
}
