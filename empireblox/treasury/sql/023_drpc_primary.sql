alter table alchemy_rpc_state add column if not exists active_provider text not null default 'drpc'
  check (active_provider in ('drpc','alchemy','legacy'));
alter table alchemy_rpc_state add column if not exists drpc_cooldown_until timestamptz;

create or replace view custody_network_readiness as
  with route as (
    select n.id as chain_id,n.enabled,
      (exists(select 1 from secrets s where s.name='drpc:API_KEY' or s.name like 'alchemy:API_KEY%')
        or exists(select 1 from secrets s where s.name='rpc:'||n.id)) as rpc_configured,
      exists(select 1 from custody_launch_assets a where a.chain_id=n.id and a.enabled) as has_assets,
      coalesce(n.scan_ready_at between clock_timestamp()-interval '2 minutes' and clock_timestamp(),false)
        and n.last_scanned>0 and exists(select 1 from scanned_blocks b where b.chain_id=n.id and
          (b.height=n.last_scanned or (n.id='SOL' and b.height<=n.last_scanned)))
        and (not exists(select 1 from secrets s where s.name='drpc:API_KEY' or s.name like 'alchemy:API_KEY%') or n.scan_ready_at >
          (select changed_at from alchemy_rpc_state where singleton)) as scan_ready
    from chains n where (n.id in ('ETH','BSC','POL') and n.kind='evm') or (n.id='SOL' and n.kind='sol')
  )
  select chain_id,rpc_configured,scan_ready,(enabled and has_assets and rpc_configured and scan_ready) as monitor_ready,
    (enabled and has_assets and rpc_configured and scan_ready and exists(select 1 from custody_public_key k where k.ready and
      (chain_id<>'SOL' or exists(select 1 from custody_sol_pool p where p.key_id=k.key_id and p.user_id is null)))) as ready
  from route;
