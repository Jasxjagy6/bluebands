-- =====================================================================
-- Game state, stored entirely on the server and resumable.
-- A player can close the tab / switch device and their active round is
-- exactly where they left it. Mine positions NEVER leave the server while a
-- round is active.
-- =====================================================================

create table if not exists mines_rounds (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references users(id) on delete cascade,
  asset_id         text not null references assets(id),
  bet              numeric(78,0) not null check (bet > 0),
  size             int not null check (size in (16,25,36,49,64)),
  mines            int not null,
  mine_positions   int[] not null,          -- server-only while active
  revealed         int[] not null default '{}',
  status           text not null default 'active' check (status in ('active','lost','cashed')),
  payout           numeric(78,0) not null default 0,
  -- provably-fair snapshot for this round:
  server_seed      text not null,
  server_seed_hash text not null,
  client_seed      text not null,
  nonce            bigint not null,
  created_at       timestamptz not null default now(),
  ended_at         timestamptz
);
-- At most one active Mines round per user.
create unique index if not exists mines_one_active on mines_rounds (user_id) where status = 'active';
create index if not exists mines_user_time on mines_rounds (user_id, created_at desc);
