-- A paid round qualifies when it settles, so an open/cancellable battle can
-- never earn a weekly prize and then return its entry fee after the reset.
create table coin_settlements (
  user_id uuid not null references users(id) on delete cascade,
  game text not null,
  round_id text not null,
  settled_at timestamptz not null default clock_timestamp(),
  primary key(user_id,game,round_id)
);
create index coin_settlement_week on coin_settlements(settled_at,user_id);
create function record_coin_settlement() returns trigger language plpgsql as $$
declare owner text;
begin
  if new.asset_id<>'COINS' then return new; end if;
  if TG_TABLE_NAME='mines_rounds' then
    if new.status in ('lost','cashed') then
      insert into coin_settlements(user_id,game,round_id) values(new.user_id,'mines',new.id::text) on conflict do nothing;
    end if;
  elsif TG_TABLE_NAME='blackjack_rounds' then
    if new.status='done' then
      insert into coin_settlements(user_id,game,round_id) values(new.user_id,'blackjack',new.id::text) on conflict do nothing;
    end if;
  elsif TG_TABLE_NAME='instant_rounds' then
    if new.game in ('cases','upgrader') then
      insert into coin_settlements(user_id,game,round_id) values(new.user_id,new.game,new.request::text) on conflict do nothing;
    end if;
  elsif TG_TABLE_NAME='battles' then
    if new.status='rolling' then
      foreach owner in array new.seats loop
        if owner is not null and owner not like 'bot:%' then
          insert into coin_settlements(user_id,game,round_id) values(owner::uuid,'battles',new.id::text) on conflict do nothing;
        end if;
      end loop;
    end if;
  end if;
  return new;
end $$;
create trigger coin_mines_settled after insert or update of status on mines_rounds for each row execute function record_coin_settlement();
create trigger coin_blackjack_settled after insert or update of status on blackjack_rounds for each row execute function record_coin_settlement();
create trigger coin_instant_settled after insert on instant_rounds for each row execute function record_coin_settlement();
create trigger coin_battle_settled after insert or update of status on battles for each row execute function record_coin_settlement();

create table coin_seasons (
  starts_at timestamptz primary key,
  ends_at timestamptz not null,
  settled_at timestamptz,
  check(ends_at=starts_at+interval '7 days')
);
insert into coin_seasons(starts_at,ends_at)
select w,w+interval '7 days' from (select date_trunc('week',clock_timestamp() at time zone 'UTC') at time zone 'UTC' as w) t;
create table coin_season_payouts (
  starts_at timestamptz not null references coin_seasons(starts_at),
  rank int not null check(rank between 1 and 10),
  user_id uuid not null references users(id),
  wagered numeric(100,0) not null check(wagered>0),
  prize numeric(78,0) not null check(prize>0),
  journal_id bigint not null unique references journals(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(starts_at,rank),unique(starts_at,user_id)
);
create trigger protect_season_payout before update or delete on coin_season_payouts for each row execute function immutable_conversion_record();

create function coin_week_rankings(first_at timestamptz,last_at timestamptz)
returns table(user_id uuid,username text,wagered numeric,rank bigint) language sql stable as $$
  with totals as (
    select s.user_id,u.username::text as username,sum(d.amount) as wagered
    from coin_settlements s join users u on u.id=s.user_id
    join wager_debits d on (d.user_id,d.game,d.round_id)=(s.user_id,s.game,s.round_id)
    join game_quotes q on q.id=d.quote_id and q.asset_id='COINS'
    where s.settled_at>=first_at and s.settled_at<last_at and not u.disabled
      and not exists(select 1 from journals j where j.kind='refund:battles' and s.game='battles' and j.ref=s.round_id)
    group by s.user_id,u.username having sum(d.amount)>0
  ) select user_id,username,wagered,row_number() over(order by wagered desc,user_id) from totals
$$;
