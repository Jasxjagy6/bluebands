-- The PKCS#8 wrapping key is NEVER stored here. Its fingerprint, the sealed
-- seed and the public wallet identity are single-assignment, including before
-- the first player is issued an address. Losing a volume is not a rekey.
create table custody_root (
  singleton boolean primary key default true check (singleton),
  key_id text not null unique check (key_id ~ '^[0-9a-f]{64}$'),
  wrap_spki bytea not null check (encode(digest(wrap_spki,'sha256'),'hex')=key_id),
  sealed_seed bytea check (octet_length(sealed_seed)=384),
  evm_xpub text check (evm_xpub ~ '^xpub[1-9A-HJ-NP-Za-km-z]{107}$'),
  fee_address text check (fee_address ~ '^0x[0-9a-f]{40}$'),
  wrap_seen_at timestamptz,
  verified_at timestamptz,
  check ((evm_xpub is null)=(fee_address is null)),
  check (evm_xpub is null or sealed_seed is not null),
  check (verified_at is null or evm_xpub is not null)
);

create function custody_keep_root() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or new.key_id is distinct from old.key_id or new.wrap_spki is distinct from old.wrap_spki
     or (old.sealed_seed is not null and old.sealed_seed is distinct from new.sealed_seed)
     or (old.evm_xpub is not null and (old.evm_xpub,old.fee_address) is distinct from (new.evm_xpub,new.fee_address)) then
    raise exception 'Custody identity is permanent';
  end if;
  return new;
end $$;
create trigger custody_keep_root before update or delete on custody_root for each row execute function custody_keep_root();

create view custody_public_key as
  select key_id,case when sealed_seed is not null or wrap_seen_at between clock_timestamp()-interval '2 minutes' and clock_timestamp()
    then replace(encode(wrap_spki,'base64'),chr(10),'') end as spki,
    sealed_seed is not null as configured, evm_xpub, fee_address,
    coalesce(verified_at between clock_timestamp()-interval '2 minutes' and clock_timestamp(),false) as ready
  from custody_root;

create sequence custody_evm_index as integer minvalue 0 start with 0 no cycle;
create table custody_evm_users (
  user_id uuid primary key references users(id), key_id text not null references custody_root(key_id),
  deriv_index integer not null check (deriv_index>=0), address text not null unique check (address ~ '^0x[0-9a-f]{40}$'),
  unique(key_id,deriv_index)
);
create table custody_sol_pool (
  key_id text not null references custody_root(key_id), deriv_index integer not null check (deriv_index>=0),
  address text not null unique check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'), user_id uuid unique references users(id),
  primary key(key_id,deriv_index)
);
create index custody_sol_available on custody_sol_pool(key_id,deriv_index) where user_id is null;

alter table deposit_addresses add column custody_kind text not null default 'legacy',
  add column custody_key_id text references custody_root(key_id),
  add check ((custody_kind='legacy' and custody_key_id is null) or
    (custody_kind='managed' and custody_key_id is not null and chain_id in ('ETH','BSC','POL','SOL') and deriv_index between 0 and 2147483647));

-- Legacy SOL imports named a player and a public address, NOT a wallet path.
-- Preserve any assigned pool entry left without its display/monitoring row;
-- an inconsistent historical owner must be reconciled, never silently flipped.
do $$ begin
  if exists(select 1 from sol_receive_pool p join deposit_addresses d on d.chain_id='SOL' and
     (p.address=d.address or p.user_id=d.user_id) where p.user_id is not null and
     (p.address<>d.address or p.user_id<>d.user_id)) then raise exception 'Conflicting legacy Solana assignments'; end if;
end $$;
insert into deposit_addresses(user_id,chain_id,address,deriv_index)
  select user_id,'SOL',address,-1 from sol_receive_pool where user_id is not null on conflict(user_id,chain_id) do nothing;

create function custody_keep_assignment() returns trigger language plpgsql as $$
begin
  if tg_table_name='custody_sol_pool' and tg_op='UPDATE' then
    if old.user_id is null and new.user_id is not null and (old.key_id,old.deriv_index,old.address)=(new.key_id,new.deriv_index,new.address)
      then return new; end if;
  end if;
  raise exception 'Custody address assignments are permanent';
end $$;
create trigger custody_keep_sol before update or delete on custody_sol_pool for each row execute function custody_keep_assignment();
create trigger custody_keep_evm before update or delete on custody_evm_users for each row execute function custody_keep_assignment();
create trigger custody_keep_deposit before update or delete on deposit_addresses for each row execute function custody_keep_assignment();
create trigger custody_keep_legacy_pool before update or delete on sol_receive_pool for each row when(old.user_id is not null)
  execute function custody_keep_assignment();
create index custody_evm_address_lookup on deposit_addresses(lower(address)) where chain_id in ('ETH','BSC','POL');

create function custody_check_address() returns trigger language plpgsql as $$
begin
  if new.custody_kind='legacy' then
    -- Old replicas must not keep assigning imported/xpub addresses after enrollment.
    perform 1 from custody_root where singleton for share;
    if exists(select 1 from custody_root where sealed_seed is not null) then raise exception 'Legacy issuance is closed'; end if;
  elsif new.chain_id='SOL' then
    if not exists(select 1 from custody_sol_pool p where (p.key_id,p.deriv_index,p.address,p.user_id)=
       (new.custody_key_id,new.deriv_index,new.address,new.user_id)) then raise exception 'Unbound custody address'; end if;
  elsif not exists(select 1 from custody_evm_users u where (u.key_id,u.deriv_index,u.address,u.user_id)=
       (new.custody_key_id,new.deriv_index,new.address,new.user_id)) then raise exception 'Unbound custody address'; end if;
  return new;
end $$;
create trigger custody_check_address before insert on deposit_addresses for each row execute function custody_check_address();

create function custody_no_legacy_collision() returns trigger language plpgsql as $$
begin
  if tg_table_name='custody_evm_users' then
    if exists(select 1 from deposit_addresses d where d.chain_id in ('ETH','BSC','POL') and lower(d.address)=new.address)
       or exists(select 1 from custody_root where fee_address=new.address) then raise exception 'Reserved receiving address'; end if;
  elsif exists(select 1 from sol_receive_pool where address=new.address) or
        exists(select 1 from deposit_addresses where chain_id='SOL' and address=new.address) then raise exception 'Reserved receiving address'; end if;
  return new;
end $$;
create trigger custody_evm_collision before insert on custody_evm_users for each row execute function custody_no_legacy_collision();
create trigger custody_sol_collision before insert on custody_sol_pool for each row execute function custody_no_legacy_collision();

-- Do not enable coins/networks here or remove old routes from the monitoring
-- tables. This is the allowlist for NEW receiving addresses, not historical scans.
create view custody_launch_assets as
  select a.* from assets a join (values
    ('ETH','ETH','ETH','native',18,null), ('BNB','BSC','BNB','native',18,null),
    ('POL','POL','POL','native',18,null), ('SOL','SOL','SOL','native',9,null),
    ('USDT.ERC20','ETH','USDT','token',6,'0xdac17f958d2ee523a2206206994597c13d831ec7'),
    ('USDT.BEP20','BSC','USDT','token',18,'0x55d398326f99059ff775485246999027b3197955'),
    ('USDT.POL','POL','USDT','token',6,'0xc2132d05d31c914a87c6611c10748aeb04b58e8f')
  ) p(id,chain_id,symbol,kind,decimals,token_address) on
    (a.id,a.chain_id,a.symbol,a.kind,a.decimals)=(p.id,p.chain_id,p.symbol,p.kind,p.decimals)
    and lower(a.token_address) is not distinct from p.token_address;

create view custody_network_readiness as
  with route as (select n.id as chain_id,n.enabled,
    exists(select 1 from secrets s where s.name='rpc:'||n.id) as rpc_configured,
    exists(select 1 from custody_launch_assets a where a.chain_id=n.id and a.enabled) as has_assets,
    coalesce(n.scan_ready_at between clock_timestamp()-interval '2 minutes' and clock_timestamp(),false)
    and n.last_scanned>0 and exists(select 1 from scanned_blocks b where b.chain_id=n.id and
       (b.height=n.last_scanned or (n.id='SOL' and b.height<=n.last_scanned))) as scan_ready
    from chains n where (n.id in ('ETH','BSC','POL') and n.kind='evm') or (n.id='SOL' and n.kind='sol'))
  select chain_id,rpc_configured,scan_ready,(enabled and has_assets and rpc_configured and scan_ready) as monitor_ready,
    (enabled and has_assets and rpc_configured and scan_ready and exists(select 1 from custody_public_key k where k.ready and
      (chain_id<>'SOL' or exists(select 1 from custody_sol_pool p where p.key_id=k.key_id and p.user_id is null)))) as ready
  from route;
