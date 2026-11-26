-- =====================================================================
-- Accounts, sessions, balances cache, provably-fair seeds.
-- This is the Supabase replacement: users, auth and per-currency balances
-- all live here now. Browser stores nothing but an httpOnly session cookie.
-- =====================================================================

create extension if not exists citext;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  username      citext not null unique check (username ~ '^[A-Za-z0-9_]{2,20}$'),
  pass_hash     text not null,
  wagered       numeric(78,0) not null default 0,   -- lifetime wagered (for levels), base units summed naively; display per-asset separately later
  display_ccy   text,
  is_admin      boolean not null default false,
  disabled      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists user_sessions (
  token_hash    bytea primary key,                  -- sha256 of the opaque cookie token
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now()
);
create index if not exists user_sessions_user on user_sessions(user_id);

-- Fast, lockable balance per (account, asset). The ledger_entries journal is
-- still the immutable source of truth; this is the running total we lock and
-- check on every spend. User accounts may NEVER go negative (DB-enforced);
-- house/external accounts may (they represent the other side of the book).
create table if not exists balances (
  account       text not null,
  asset_id      text not null references assets(id),
  amount        numeric(78,0) not null default 0,
  primary key (account, asset_id),
  constraint balances_user_nonneg check (account not like 'u:%' or amount >= 0)
);

-- Backfill from any existing journal entries (no-op on a fresh DB).
insert into balances(account, asset_id, amount)
  select account, asset_id, sum(delta) from ledger_entries group by account, asset_id
on conflict (account, asset_id) do nothing;

-- Provably-fair seed state per user.
create table if not exists user_fair (
  user_id            uuid primary key references users(id) on delete cascade,
  server_seed        text not null,
  server_seed_hash   text not null,
  client_seed        text not null,
  nonce              bigint not null default 0,
  prev_server_seed   text,          -- revealed after a rotation, for verification
  prev_server_hash   text,
  updated_at         timestamptz not null default now()
);
