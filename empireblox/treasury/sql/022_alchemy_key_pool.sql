-- Keep Alchemy credentials in the existing encrypted secrets vault.  This
-- table contains only routing state and a global compute-unit token bucket.
create table if not exists alchemy_rpc_state (
  singleton boolean primary key default true check (singleton),
  active_slot smallint not null default 1 check (active_slot between 0 and 10),
  deposits_paused boolean not null default false,
  changed_at timestamptz not null default clock_timestamp()
);
insert into alchemy_rpc_state(singleton) values(true) on conflict do nothing;

create table if not exists alchemy_rpc_key_health (
  slot smallint primary key check (slot between 1 and 10),
  cooldown_until timestamptz,
  failures integer not null default 0 check (failures >= 0)
);
insert into alchemy_rpc_key_health(slot)
select n from generate_series(1,10) n on conflict do nothing;

-- A 60 CU request-sized burst, replenished at 240 CU/s. Token-bucket
-- capacity plus refill caps each rolling second at 300 CU.
create table if not exists alchemy_rpc_budget (
  singleton boolean primary key default true check (singleton),
  tokens numeric not null default 60 check (tokens >= 0 and tokens <= 60),
  updated_at timestamptz not null default clock_timestamp()
);
insert into alchemy_rpc_budget(singleton) values(true) on conflict do nothing;

-- The pre-pool implementation stored its single key under this name; slot 1
-- deliberately continues to use that name, so no plaintext migration occurs.

create or replace view custody_network_readiness as
  with route as (
    select n.id as chain_id,n.enabled,
      (exists(select 1 from secrets s where s.name like 'alchemy:API_KEY%') or exists(select 1 from secrets s where s.name='rpc:'||n.id)) as rpc_configured,
      exists(select 1 from custody_launch_assets a where a.chain_id=n.id and a.enabled) as has_assets,
      coalesce(n.scan_ready_at between clock_timestamp()-interval '2 minutes' and clock_timestamp(),false)
        and n.last_scanned>0 and exists(select 1 from scanned_blocks b where b.chain_id=n.id and
          (b.height=n.last_scanned or (n.id='SOL' and b.height<=n.last_scanned)))
        and (not exists(select 1 from secrets s where s.name like 'alchemy:API_KEY%') or n.scan_ready_at >
          (select changed_at from alchemy_rpc_state where singleton)) as scan_ready
    from chains n where (n.id in ('ETH','BSC','POL') and n.kind='evm') or (n.id='SOL' and n.kind='sol')
  )
  select chain_id,rpc_configured,scan_ready,(enabled and has_assets and rpc_configured and scan_ready) as monitor_ready,
    (enabled and has_assets and rpc_configured and scan_ready and exists(select 1 from custody_public_key k where k.ready and
      (chain_id<>'SOL' or exists(select 1 from custody_sol_pool p where p.key_id=k.key_id and p.user_id is null)))) as ready
  from route;
