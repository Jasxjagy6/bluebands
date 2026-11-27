-- Provider access and availability can differ by network (for example, a
-- dRPC plan may include EVM networks but exclude Solana). Cool down only the
-- affected route, then automatically retry the primary after its cooldown.
create table if not exists drpc_rpc_chain_health (
  chain_id text primary key references chains(id),
  cooldown_until timestamptz,
  failures integer not null default 0 check (failures >= 0),
  last_error text check (last_error in ('throttle','credential','unavailable','unsupported'))
);
insert into drpc_rpc_chain_health(chain_id)
select id from chains where id in ('ETH','BSC','POL','SOL') on conflict do nothing;

-- Recover installations stranded on the old global fallback. No address,
-- deposit, balance or scan cursor is changed; scanners must renew readiness.
update alchemy_rpc_state set active_provider='drpc',drpc_cooldown_until=null,
  deposits_paused=true,changed_at=clock_timestamp(),routing_epoch=routing_epoch+1
where singleton and exists(select 1 from secrets where name='drpc:API_KEY');

create or replace view custody_network_readiness as
  with route as (
    select n.id as chain_id,n.enabled,
      (case when n.id='SOL' then
        exists(select 1 from secrets where name like 'alchemy:API_KEY%') or
        (not exists(select 1 from secrets where name='drpc:API_KEY') and exists(select 1 from secrets where name='rpc:SOL'))
      else exists(select 1 from secrets where name='drpc:API_KEY' or name like 'alchemy:API_KEY%' or name='rpc:'||n.id) end) as rpc_configured,
      exists(select 1 from custody_launch_assets a where a.chain_id=n.id and a.enabled) as has_assets,
      coalesce(n.scan_ready_at between clock_timestamp()-interval '2 minutes' and clock_timestamp(),false)
        and n.last_scanned>0 and exists(select 1 from scanned_blocks b where b.chain_id=n.id and
          (b.height=n.last_scanned or (n.id='SOL' and b.height<=n.last_scanned)))
        and (not exists(select 1 from secrets where name='drpc:API_KEY' or name like 'alchemy:API_KEY%') or n.scan_ready_at >
          (select changed_at from alchemy_rpc_state where singleton)) as scan_ready
    from chains n where (n.id in ('ETH','BSC','POL') and n.kind='evm') or (n.id='SOL' and n.kind='sol')
  )
  select chain_id,rpc_configured,scan_ready,(enabled and has_assets and rpc_configured and scan_ready) as monitor_ready,
    (enabled and has_assets and rpc_configured and scan_ready and exists(select 1 from custody_public_key k where k.ready and
      (chain_id<>'SOL' or exists(select 1 from custody_sol_pool p where p.key_id=k.key_id and p.user_id is null)))) as ready
  from route;
