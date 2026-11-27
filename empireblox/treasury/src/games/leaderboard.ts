import { query,tx } from '../db.js';
import { post } from '../ledger.js';
import { COINS,COIN_SCALE } from '../coins.js';

// Same 500,000-coin weekly schedule as the supplied reference project.
export const WEEKLY_PRIZES=[150000n,100000n,70000n,50000n,40000n,30000n,20000n,15000n,15000n,10000n].map(n=>n*COIN_SCALE);
export const SEASON_LOCK="hashtext('banditblox coin season boundary')";

/** Durable catch-up, fenced across replicas and idempotent with its journals. */
export async function settleCoinSeasons(){
  const due=(await query(`select 1 from coin_seasons where settled_at is null and ends_at<=clock_timestamp() limit 1`)).rowCount;
  if(!due)return 0;
  return tx(async c=>{
    // Player transactions take the shared side BEFORE their user/balance
    // locks. All rounds finishing before a boundary commit before it seals;
    // a round waiting for the next week is stamped only after this lock.
    await c.query(`select pg_advisory_xact_lock(${SEASON_LOCK})`);
    const seasons=(await c.query(`select * from coin_seasons where settled_at is null and ends_at<=clock_timestamp()
      order by starts_at limit 8 for update`)).rows;
    for(const season of seasons){
      const winners=(await c.query(`select user_id,wagered::text,rank::int from coin_week_rankings($1,$2) where rank<=10 order by rank`,[season.starts_at,season.ends_at])).rows;
      for(const winner of winners){
        const prize=WEEKLY_PRIZES[winner.rank-1]!,ref=new Date(season.starts_at).toISOString()+'/'+winner.user_id;
        const journal=await post(c,'leaderboard_prize',ref,[{account:'house:rewards',asset:COINS,delta:-prize},{account:'u:'+winner.user_id,asset:COINS,delta:prize}]);
        await c.query('insert into coin_season_payouts(starts_at,rank,user_id,wagered,prize,journal_id) values($1,$2,$3,$4,$5,$6)',
          [season.starts_at,winner.rank,winner.user_id,winner.wagered,prize.toString(),journal]);
        await c.query("select notify_player($1,'leaderboard.prize',$2,'COINS',$3)",[winner.user_id,ref,prize.toString()]);
      }
      await c.query('update coin_seasons set settled_at=clock_timestamp() where starts_at=$1',[season.starts_at]);
    }
    // Recreate every missed season after downtime, including the current one.
    await c.query(`insert into coin_seasons(starts_at,ends_at)
      select w,w+interval '7 days' from generate_series((select max(starts_at) from coin_seasons)+interval '7 days',
        date_trunc('week',clock_timestamp() at time zone 'UTC') at time zone 'UTC',interval '7 days') w on conflict do nothing`);
    return seasons.length;
  });
}

export async function coinLeaderboard(uid:string|null){
  await settleCoinSeasons();
  const row=(await query(`with week as (select date_trunc('week',clock_timestamp() at time zone 'UTC') at time zone 'UTC' as starts_at),
    ranked as (select r.user_id,r.username,r.wagered,r.rank from week,
      lateral coin_week_rankings(week.starts_at,week.starts_at+interval '7 days') r)
    select starts_at,starts_at+interval '7 days' as ends_at,
      (select coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'username',r.username,'wagered',r.wagered::text,'rank',r.rank::text) order by r.rank),'[]') from ranked r where rank<=50) as top,
      (select jsonb_build_object('user_id',r.user_id,'username',r.username,'wagered',r.wagered::text,'rank',r.rank::text) from ranked r where r.user_id=$1) as me,
      (select count(*)::text from ranked) as participants,(select coalesce(sum(wagered),0)::text from ranked) as total_wagered,
      (select coalesce(jsonb_agg(jsonb_build_object('user_id',p.user_id,'username',u.username,'wagered',p.wagered::text,'prize',p.prize::text,'rank',p.rank) order by p.rank),'[]')
        from coin_season_payouts p join users u on u.id=p.user_id where p.starts_at=week.starts_at-interval '7 days') as last_week
    from week`,[uid])).rows[0];
  return {...row,asset_id:COINS,prizes:WEEKLY_PRIZES.map(String),prize_pool:WEEKLY_PRIZES.reduce((a,b)=>a+b,0n).toString()};
}
