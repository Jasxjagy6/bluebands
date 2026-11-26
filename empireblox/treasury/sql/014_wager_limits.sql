create table wager_limits (
  singleton boolean primary key default true check (singleton),
  min_units numeric(78,0) not null default 0 check (min_units >= 0),
  max_units numeric(78,0) check (max_units > 0 and max_units >= min_units)
);
insert into wager_limits default values;

-- Both legs come from a single USD-base market response. Old catalog-only
-- quotes remain available for old receipts, but cannot authorize a new debit.
alter table game_quotes add column quoted_at timestamptz,
  add column usdt_per_usd numeric,
  add check (quoted_at is null or (minor_per_usd is not null and usdt_per_usd is not null
    and usdt_per_usd > 0 and expires_at > quoted_at and expires_at <= quoted_at + interval '2 minutes'));
-- A satoshi can be worth more than one catalog point. Such quotes can value a
-- native-denominated stake, but cannot be offered as payable catalog prices.
alter table game_quotes drop constraint game_quotes_unit_check, add check (unit >= 0);

-- Debit receipts reference these legs by ID; a correction needs a new ID.
-- An operator may still retire a quote early by shortening its expiry.
create function immutable_quote_price() returns trigger language plpgsql as $$
begin
  raise exception 'Issue a new quote instead of changing a recorded market price' using errcode='23514';
end $$;
create trigger protect_quote_price before update of asset_id,unit,minor_per_usd,usdt_per_usd,quoted_at on game_quotes
  for each row execute function immutable_quote_price();

-- One immutable valuation per actual human stake, including additional cards
-- and late battle seats. Amount is in the quote asset's *ledger minor units*.
create table wager_debits (
  journal_id bigint primary key references journals(id),
  user_id uuid not null references users(id) on delete cascade,
  game text not null, round_id text not null,
  amount numeric(78,0) not null check (amount > 0),
  quote_id uuid not null references game_quotes(id)
);
create index wager_debit_round on wager_debits(user_id,game,round_id);
create view valued_debits as
select d.*, q.minor_per_usd, q.usdt_per_usd,
  div(d.amount * 1e18::numeric, q.minor_per_usd) * 1e-18::numeric as usd,
  div(d.amount * 1e18::numeric * q.usdt_per_usd, q.minor_per_usd) * 1e-18::numeric as usdt,
  div(d.amount * 600, q.minor_per_usd) as catalog_xp
from wager_debits d join game_quotes q on q.id=d.quote_id;

-- Preserve already-recognized USD progress for legacy stakes. Only the part
-- without a debit snapshot uses the old schedule; never apply today's quote
-- to it. A legacy native stake with no USDT leg remains explicitly unpriced.
create or replace view vip_wagers as
select b.user_id,b.game,b.id,
  case when s.usd is not null or old.usd is not null then coalesce(s.usd,0)+coalesce(old.usd,0) end as usd,
  case when s.usdt is not null or old.usdt is not null then coalesce(s.usdt,0)+coalesce(old.usdt,0) end as usdt,
  old.usd is null as unpriced_usd, old.usdt is null as unpriced_usdt,
  b.created_at,b.asset_id,b.stake,b.payout
from player_bets b join assets a on a.id=b.asset_id
left join lateral (select sum(d.amount) as amount,sum(d.usd) as usd,sum(d.usdt) as usdt
  from valued_debits d where (d.user_id,d.game,d.round_id)=(b.user_id,b.game,b.id)) s on true
cross join lateral (select b.stake * case when a.symbol='USDT' then power(10::numeric,18-a.decimals) else 1 end
  - coalesce(s.amount,0) as amount) legacy
left join mines_rounds m on legacy.amount>0 and b.game='mines' and m.id::text=b.id and m.user_id=b.user_id
left join blackjack_rounds j on legacy.amount>0 and b.game='blackjack' and j.id::text=b.id and j.user_id=b.user_id
left join instant_rounds i on legacy.amount>0 and i.game=b.game and i.user_id=b.user_id and i.request::text=b.id
left join battles t on legacy.amount>0 and b.game='battles' and t.id::text=b.id
cross join lateral (select
  case when legacy.amount=0 then 0 when a.symbol='USDT' then legacy.amount*1e-18::numeric
    else div(legacy.amount * 1e18::numeric, coalesce(m.minor_per_usd,j.minor_per_usd,i.minor_per_usd,t.minor_per_usd,t.unit*600,
      case when i.game='cases' then (i.result->>'stake')::numeric/nullif((i.result->>'price')::numeric,0)*600 end,
      (select coalesce(q.minor_per_usd,q.unit*600) from game_quotes q where q.quoted_at is null and q.asset_id=b.asset_id
       and q.expires_at between b.created_at and b.created_at+interval '2 minutes' order by q.expires_at desc limit 1))) * 1e-18::numeric end as usd,
  case when legacy.amount=0 then 0 when a.symbol='USDT' then legacy.amount*1e-18::numeric end as usdt) old
where b.stake>0 and b.status in ('lost','cashed','done','rolling');
