-- =====================================================================
-- EmpireBlox Treasury — schema (deposit system v1)
-- Run with: npm run migrate
--
-- Design rules that make this safe for real money:
--   * Balances are NEVER stored as an editable number. A balance is the
--     SUM of immutable ledger entries. Nobody — no admin, no function —
--     can set a balance directly.
--   * Money only ever enters via a CONFIRMED on-chain deposit.
--   * Every deposit is idempotent on (chain, txid, log_index), so a tx
--     seen twice (retries, reorgs, restarts) can only credit once.
--   * Amounts are integers in each asset's smallest unit (wei, sat, 6dp
--     for USDT). No floating point ever touches money.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Chains and assets (reference data)
-- ---------------------------------------------------------------------
create table if not exists chains (
  id                text primary key,          -- 'ETH','BSC','POL','BTC','SOL','TRON'
  kind              text not null,             -- 'evm','btc','sol','tron'
  display_name      text not null,
  enabled           boolean not null default false,
  last_scanned      bigint not null default 0, -- last block/slot fully processed
  required_conf     int not null default 15,   -- confirmations before crediting
  created_at        timestamptz not null default now()
);

create table if not exists assets (
  id                text primary key,          -- 'ETH','USDT.ERC20','BNB','USDT.BEP20','POL','USDT.POL',...
  chain_id          text not null references chains(id),
  symbol            text not null,             -- display symbol, e.g. 'USDT'
  kind              text not null,             -- 'native' | 'token'
  token_address     text,                      -- contract address for tokens (lowercased), null for native
  decimals          int not null,
  min_deposit       numeric(78,0) not null default 0,  -- in smallest units; deposits below are ignored
  enabled           boolean not null default true,
  created_at        timestamptz not null default now()
);
create index if not exists assets_chain on assets(chain_id);
create unique index if not exists assets_token_uq on assets(chain_id, lower(token_address)) where token_address is not null;

-- ---------------------------------------------------------------------
-- Per-user deposit addresses (derived from a watch-only xpub)
-- One address per (user, chain); on EVM that same address receives the
-- native coin AND every token on that chain.
-- ---------------------------------------------------------------------
create table if not exists address_counters (
  chain_id          text primary key references chains(id),
  next_index        bigint not null default 0
);

create table if not exists deposit_addresses (
  id                bigint generated always as identity primary key,
  user_id           uuid not null,             -- Supabase auth uid
  chain_id          text not null references chains(id),
  address           text not null,             -- stored lowercased for EVM
  deriv_index       bigint not null,
  created_at        timestamptz not null default now(),
  unique (user_id, chain_id),
  unique (chain_id, address)
);
create index if not exists dep_addr_lookup on deposit_addresses(chain_id, address);

-- ---------------------------------------------------------------------
-- Double-entry ledger
--   journals  = one money event (a deposit, later a withdrawal, a bet…)
--   entries   = the debits/credits; per journal they must sum to 0 per asset
-- Account naming:
--   'u:<uuid>'   a user's spendable balance
--   'ext:<chain>' the outside world (where deposits come from)
--   'house:*'     house/fee accounts (later)
-- ---------------------------------------------------------------------
create table if not exists journals (
  id                bigint generated always as identity primary key,
  kind              text not null,             -- 'deposit', (later) 'withdrawal','bet','payout'
  ref               text,                      -- free-form reference (e.g. deposit id)
  created_at        timestamptz not null default now()
);

create table if not exists ledger_entries (
  id                bigint generated always as identity primary key,
  journal_id        bigint not null references journals(id),
  account           text not null,
  asset_id          text not null references assets(id),
  delta             numeric(78,0) not null,    -- +credit / -debit, smallest units
  created_at        timestamptz not null default now()
);
create index if not exists ledger_acct on ledger_entries(account, asset_id);
create index if not exists ledger_journal on ledger_entries(journal_id);

-- Spendable balance for any account+asset = sum of its entries.
create or replace view account_balances as
  select account, asset_id, sum(delta) as amount
  from ledger_entries group by account, asset_id;

-- Convenience: a single user's balances across assets.
create or replace function user_balances(p_user uuid)
returns table(asset_id text, amount numeric) language sql stable as $$
  select asset_id, coalesce(sum(delta),0)
  from ledger_entries where account = 'u:' || p_user::text
  group by asset_id
$$;

-- ---------------------------------------------------------------------
-- Observed deposits. The unique index is the idempotency guarantee.
-- ---------------------------------------------------------------------
create table if not exists deposits (
  id                bigint generated always as identity primary key,
  chain_id          text not null references chains(id),
  asset_id          text not null references assets(id),
  user_id           uuid not null,
  address           text not null,
  txid              text not null,
  log_index         int not null default 0,    -- 0 for native transfers; log index for token transfers
  amount            numeric(78,0) not null,     -- smallest units
  block_number      bigint not null,
  block_hash        text,
  confirmations     int not null default 0,
  required_conf     int not null,
  status            text not null default 'pending', -- 'pending'|'confirmed'|'credited'|'orphaned'
  journal_id        bigint references journals(id),   -- set once credited
  first_seen_at     timestamptz not null default now(),
  confirmed_at      timestamptz,
  credited_at       timestamptz,
  unique (chain_id, txid, log_index)
);
create index if not exists deposits_user on deposits(user_id, first_seen_at desc);
create index if not exists deposits_status on deposits(status) where status in ('pending','confirmed');

-- ---------------------------------------------------------------------
-- Encrypted secret vault (envelope encryption; see src/vault.ts)
-- We store only ciphertext. The master key (KEK) lives in env/KMS, never
-- here. Secret VALUES are never returned to the browser — the admin panel
-- can set and see "is set / last4", never read back the plaintext.
-- ---------------------------------------------------------------------
create table if not exists secrets (
  name              text primary key,          -- e.g. 'xpub:ETH', 'rpc:ETH', 'rpc_key:ETH'
  enc_dek           bytea not null,            -- data key, encrypted under the KEK
  iv                bytea not null,            -- GCM nonce for the ciphertext
  tag               bytea not null,            -- GCM auth tag
  ciphertext        bytea not null,
  hint              text,                      -- safe, non-secret hint (e.g. last 4 chars)
  updated_at        timestamptz not null default now(),
  updated_by        text
);

-- ---------------------------------------------------------------------
-- Admin accounts (separate from game login). Password = scrypt. 2FA = TOTP.
-- ---------------------------------------------------------------------
create table if not exists admin_users (
  id                bigint generated always as identity primary key,
  username          text not null unique,
  pass_hash         text not null,             -- scrypt: salt:hash (base64)
  totp_secret_enc   bytea,                     -- TOTP secret, encrypted via vault helper
  totp_iv           bytea,
  totp_tag          bytea,
  totp_dek          bytea,
  totp_enabled      boolean not null default false,
  disabled          boolean not null default false,
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz
);

-- ---------------------------------------------------------------------
-- Global settings (admin-controlled kill switches & limits)
-- ---------------------------------------------------------------------
create table if not exists settings (
  key               text primary key,
  value             jsonb not null,
  updated_at        timestamptz not null default now()
);
insert into settings(key, value) values
  ('deposits_paused', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Append-only audit log of every privileged action
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id                bigint generated always as identity primary key,
  actor             text not null,             -- admin username or 'system'
  action            text not null,
  detail            jsonb not null default '{}'::jsonb,
  ip                text,
  created_at        timestamptz not null default now()
);
create index if not exists audit_time on audit_log(created_at desc);

-- =====================================================================
-- Seed: chains and assets. EVM family enabled; others seeded but disabled
-- until their watchers ship. Confirmation counts are conservative starts.
-- =====================================================================
insert into chains(id, kind, display_name, enabled, required_conf) values
  ('ETH',  'evm',  'Ethereum',   true,  15),
  ('BSC',  'evm',  'BNB Chain',  true,  15),
  ('POL',  'evm',  'Polygon',    true,  128),
  ('BTC',  'btc',  'Bitcoin',    false, 2),
  ('SOL',  'sol',  'Solana',     false, 1),
  ('TRON', 'tron', 'Tron',       false, 20)
on conflict (id) do nothing;

insert into address_counters(chain_id)
  select id from chains on conflict (chain_id) do nothing;

-- Native + USDT per chain. min_deposit values are examples — tune in admin.
-- USDT token addresses: fill the real mainnet/testnet contract in the admin
-- panel or here before enabling. (Left null + disabled where unknown.)
insert into assets(id, chain_id, symbol, kind, token_address, decimals, min_deposit, enabled) values
  ('ETH',        'ETH',  'ETH',  'native', null,                                          18, 2000000000000000,  true),
  ('USDT.ERC20', 'ETH',  'USDT', 'token',  '0xdac17f958d2ee523a2206206994597c13d831ec7', 6,  1000000,           true),
  ('BNB',        'BSC',  'BNB',  'native', null,                                          18, 10000000000000000, true),
  ('USDT.BEP20', 'BSC',  'USDT', 'token',  '0x55d398326f99059ff775485246999027b3197955', 18, 1000000000000000000, true),
  ('POL',        'POL',  'POL',  'native', null,                                          18, 1000000000000000000, true),
  ('USDT.POL',   'POL',  'USDT', 'token',  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 6,  1000000,           true)
on conflict (id) do nothing;
