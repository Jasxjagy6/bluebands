alter table chains add column if not exists scan_ready_at timestamptz;
create table if not exists scanned_blocks (
  chain_id text not null references chains(id),
  height bigint not null,
  hash text not null,
  primary key (chain_id, height)
);
-- EVM token log indexes start at zero. Reserve a distinct index for native transfers.
update deposits d set log_index=-1 from assets a
 where a.id=d.asset_id and a.kind='native' and d.log_index=0;
