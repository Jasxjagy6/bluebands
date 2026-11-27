-- Coins are an internal ledger denomination. Crypto receive routes, addresses,
-- observations, holds and historical game denominations are left untouched.
insert into assets(id,chain_id,symbol,kind,decimals,enabled)
values ('COINS','ETH','COINS','ledger',18,true) on conflict(id) do nothing;

create view wallet_assets as
select a.* from assets a where a.enabled and a.kind in ('native','ledger') and a.id<>'COINS';
create or replace view playing_assets as select a.* from assets a where a.id='COINS' and a.enabled;
alter table users alter column display_ccy set default 'COINS';
update users set display_ccy='COINS' where display_ccy is distinct from 'COINS';

-- Also fences an old API replica during a rolling release. Already purchased
-- rounds can finish/pay/refund in their original asset, but cannot buy more
-- crypto stakes. Never redenominate a live round or a historical receipt.
create function require_coin_stake() returns trigger language plpgsql as $$
begin
  if new.account like 'u:%' and new.delta<0 and new.asset_id<>'COINS'
    and exists(select 1 from journals where id=new.journal_id and kind like 'bet:%') then
    raise exception 'New wagers require coins. Convert crypto in your profile first.' using errcode='23514';
  end if;
  return new;
end $$;
create trigger coin_only_wagers before insert on ledger_entries for each row execute function require_coin_stake();

create table conversion_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  asset_id text not null references assets(id) check(asset_id<>'COINS'),
  direction text not null check(direction in ('crypto_to_coins','coins_to_crypto')),
  input_amount numeric(78,0) not null check(input_amount>0),
  crypto_amount numeric(78,0) not null check(crypto_amount>0),
  coin_amount numeric(78,0) not null check(coin_amount>0),
  market_quote_id uuid references game_quotes(id),
  -- coins (minor units) per one crypto minor unit, as an exact fraction.
  rate_num numeric not null check(rate_num>0),
  rate_den numeric not null check(rate_den>0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check(expires_at>created_at and expires_at<=created_at+interval '30 seconds'),
  check(input_amount=case when direction='crypto_to_coins' then crypto_amount else coin_amount end)
);
create index conversion_quote_owner on conversion_quotes(user_id,created_at desc);
create function immutable_conversion_record() returns trigger language plpgsql as $$
begin
  raise exception 'Conversion records are immutable; request a new quote' using errcode='23514';
end $$;
create trigger protect_conversion_quote before update or delete on conversion_quotes for each row execute function immutable_conversion_record();

create table wallet_conversions (
  id uuid primary key,
  user_id uuid not null references users(id),
  request uuid not null,
  quote_id uuid not null unique references conversion_quotes(id),
  journal_id bigint not null unique references journals(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,request)
);
create index conversion_history on wallet_conversions(user_id,created_at desc);
create trigger protect_conversion_receipt before update or delete on wallet_conversions for each row execute function immutable_conversion_record();

-- Frozen historical valuations can be presented in coins without rewriting a
-- crypto receipt or valuing old stakes at today's price. Unpriced stays null.
create view coin_wagers as
select v.*,
  case when v.asset_id='COINS' then v.stake
    else floor(coalesce(v.usdt,v.usd)*600*1e18::numeric) end as stake_coins,
  case when v.asset_id='COINS' then v.payout
    else floor(coalesce(v.usdt,v.usd)*600*1e18::numeric*v.payout/nullif(v.stake,0)) end as payout_coins
from vip_wagers v;

-- Preserve already earned catalog progress, including old unpriced catalog
-- rounds, while finally counting settled Mines and Blackjack as well.
create view reward_progress as
select u.id as user_id,greatest(u.catalog_wagered,
  coalesce((select floor(sum(w.stake_coins)/1e18::numeric) from coin_wagers w where w.user_id=u.id),0)) as wagered
from users u;
