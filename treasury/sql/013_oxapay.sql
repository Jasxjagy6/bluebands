insert into settings(key,value) values ('deposit_provider','"oxapay"') on conflict(key) do nothing;

-- A request is reserved before talking to the merchant. dispatched_at is a one-way
-- fence: even after a timeout or process crash it is never safe to POST it again.
create table oxapay_invoices (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id), request uuid not null,
  asset_id text not null references assets(id), symbol text not null, decimals int not null check(decimals between 0 and 36),
  amount numeric(78,0) not null check(amount>0), public_origin text not null,
  networks text[] not null default '{}', network_aliases jsonb not null default '{}', dispatched_at timestamptz,
  track_id text unique, payment_url text, expires_at timestamptz,
  status text not null default 'creating' check(status in ('creating','waiting','paying','underpaid','review','expired','failed','credited')),
  review_reason text, pending_at timestamptz, journal_id bigint unique references journals(id), credited_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  next_check_at timestamptz default now()+interval '2 minutes', history_page int not null default 1 check(history_page>0),
  probe_seq bigint not null default 0, applied_seq bigint not null default 0,
  unique(user_id,request), check((status='credited')=(journal_id is not null)),
  check((credited_at is not null)=(journal_id is not null)), check(applied_seq<=probe_seq),
  check(dispatched_at is null or cardinality(networks)>0), check(track_id is null or dispatched_at is not null),
  check(journal_id is null or track_id is not null)
);
create index oxapay_player_history on oxapay_invoices(user_id,created_at desc);
create index oxapay_due on oxapay_invoices(next_check_at) where next_check_at is not null;
create unique index oxapay_deposit_journal on journals(ref) where kind='deposit' and ref like 'oxapay:%';

create function protect_oxapay_invoice() returns trigger language plpgsql as $$
begin
  if (new.id,new.user_id,new.request,new.asset_id,new.symbol,new.decimals,new.amount,new.public_origin,new.created_at)
       is distinct from (old.id,old.user_id,old.request,old.asset_id,old.symbol,old.decimals,old.amount,old.public_origin,old.created_at)
    or (old.dispatched_at is not null and (new.dispatched_at,new.networks,new.network_aliases)
       is distinct from (old.dispatched_at,old.networks,old.network_aliases))
    or (old.track_id is not null and new.track_id is distinct from old.track_id)
    or (old.journal_id is not null and (new.journal_id,new.credited_at) is distinct from (old.journal_id,old.credited_at)) then
    raise exception 'Issued invoice terms and settled journal are immutable';
  end if;
  return new;
end $$;
create trigger oxapay_immutable before update on oxapay_invoices for each row execute function protect_oxapay_invoice();

-- Hosted custody never allocates a player deposit address. If the provider
-- attributes the same chain transaction to two orders, the second needs review
-- (v1 does not provide an output/log index that would disambiguate it).
create table oxapay_transfers (
  invoice_id uuid not null references oxapay_invoices(id), chain_id text not null, txid text not null,
  amount numeric(78,0) not null check(amount>0), address text not null, primary key(chain_id,txid)
);
create index oxapay_transfer_invoice on oxapay_transfers(invoice_id);
