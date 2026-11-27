-- The sweep queue moves custody inventory, never player balances. Every signed
-- transaction and its input terms are retained, including failed/ambiguous sends.
create table custody_sweep_networks (
  chain_id text primary key references chains(id) check(chain_id in ('ETH','BSC','POL','SOL')),
  destination text, sweeps_enabled boolean not null default false,
  check(not sweeps_enabled or destination is not null),
  check(destination is null or case when chain_id='SOL' then
    destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' and destination<>'11111111111111111111111111111111'
    else destination ~ '^0x[0-9a-f]{40}$' and destination !~ '^0x0{36}' and
      destination not in ('0xdac17f958d2ee523a2206206994597c13d831ec7','0x55d398326f99059ff775485246999027b3197955',
        '0xc2132d05d31c914a87c6611c10748aeb04b58e8f') end)
);
insert into custody_sweep_networks(chain_id) values ('ETH'),('BSC'),('POL'),('SOL');

-- Unique reservations serialize allocation and configuration even when neither
-- conflicting address existed at the beginning of either transaction. Former
-- destinations cannot later become deposit addresses and create a credit loop.
create table custody_address_roles (
  family text not null check(family in ('evm','sol')), address text not null,
  role text not null check(role in ('receive','collection','fee')), primary key(family,address)
);
create function custody_keep_role() returns trigger language plpgsql as $$
begin raise exception 'Custody address roles are permanent'; end $$;
create trigger custody_keep_role before update or delete on custody_address_roles for each row execute function custody_keep_role();
create function custody_reserve_address(f text, a text, r text) returns void language plpgsql as $$
begin
  if a is null then return; end if;
  if f='evm' then a:=lower(a); end if;
  insert into custody_address_roles(family,address,role) values(f,a,r) on conflict do nothing;
  if not found and not exists(select 1 from custody_address_roles where family=f and address=a and role=r) then
    raise exception 'Custody address role conflict';
  end if;
end $$;
select custody_reserve_address(case when chain_id='SOL' then 'sol' else 'evm' end,address,'receive')
  from deposit_addresses where chain_id in ('ETH','BSC','POL','SOL');
select custody_reserve_address('sol',address,'receive') from sol_receive_pool;
select custody_reserve_address('sol',address,'receive') from custody_sol_pool;
select custody_reserve_address('evm',address,'receive') from custody_evm_users;
select custody_reserve_address('evm',fee_address,'fee') from custody_root;
create function custody_protect_address() returns trigger language plpgsql as $$
begin
  if tg_table_name='custody_root' then perform custody_reserve_address('evm',new.fee_address,'fee');
  elsif tg_table_name='deposit_addresses' then
    if new.chain_id in ('ETH','BSC','POL','SOL') then
      perform custody_reserve_address(case when new.chain_id='SOL' then 'sol' else 'evm' end,new.address,'receive');
    end if;
  else perform custody_reserve_address(tg_argv[0],new.address,'receive'); end if;
  return new;
end $$;
create trigger custody_register_fee before insert or update of fee_address on custody_root for each row execute function custody_protect_address();
create trigger custody_register_issued before insert or update of address,chain_id on deposit_addresses for each row execute function custody_protect_address();
create trigger custody_register_sol before insert or update of address on custody_sol_pool for each row execute function custody_protect_address('sol');
create trigger custody_register_evm before insert or update of address on custody_evm_users for each row execute function custody_protect_address('evm');
create trigger custody_register_legacy_sol before insert or update of address on sol_receive_pool for each row execute function custody_protect_address('sol');

create domain custody_sweep_reason as text check(value in ('wrong_chain','orphaned','unowned','dust','fee_limit','insufficient_funds',
  'expired','nonce_conflict','invalid_receipt','ambiguous','not_final','unavailable','invalid_intent'));
create table custody_sweep_jobs (
  id bigint generated always as identity primary key, deposit_id bigint not null unique references deposits(id),
  journal_id bigint not null unique references journals(id), address_id bigint not null references deposit_addresses(id),
  chain_id text not null references custody_sweep_networks(chain_id), asset_id text not null references assets(id),
  source text not null, destination text not null check(destination<>source), sponsor text check(sponsor<>source and sponsor<>destination),
  key_id text not null, deriv_index bigint not null check(deriv_index between 0 and 2147483647),
  amount numeric(78,0) not null check(amount>0), deposit_txid text not null, deposit_index integer not null,
  deposit_block bigint not null check(deposit_block>0), deposit_block_hash text not null, required_conf integer not null check(required_conf>0),
  finality_conf integer not null check(finality_conf>=required_conf),
  status text not null default 'queued' check(status in ('queued','sponsor_signed','sponsor_pending','sponsored','sweep_signed','sweep_pending','completed','review','dust')),
  last_error custody_sweep_reason, next_check_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), completed_at timestamptz,
  unique(id,chain_id), unique(chain_id,deposit_txid,deposit_index), check((chain_id='SOL')=(sponsor is null)), check((status='completed')=(completed_at is not null))
);
create index custody_sweeps_due on custody_sweep_jobs(chain_id,next_check_at,id) where status not in ('completed','review','dust');
create index custody_sweeps_source on custody_sweep_jobs(chain_id,source,id) where status not in ('completed','dust');
create unique index custody_one_active_source on custody_sweep_jobs(chain_id,source) where status not in ('queued','completed','dust');

create function custody_protect_network() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or new.chain_id<>old.chain_id then raise exception 'Immutable custody network'; end if;
  if new.destination is distinct from old.destination then
    if old.sweeps_enabled or new.sweeps_enabled or exists(select 1 from custody_sweep_jobs
      where chain_id=old.chain_id and status not in ('completed','dust')) then raise exception 'Collection destination is pinned'; end if;
    perform custody_reserve_address(case when new.chain_id='SOL' then 'sol' else 'evm' end,new.destination,'collection');
  end if;
  return new;
end $$;
create trigger custody_pin_network before update or delete on custody_sweep_networks for each row execute function custody_protect_network();

create table custody_sweep_steps (
  job_id bigint not null, chain_id text not null, phase text not null check(phase in ('sponsor','sweep')),
  txid text not null, raw bytea not null check(octet_length(raw) between 1 and 4096),
  signer text not null, amount numeric(78,0) not null check(amount>0), fee numeric(78,0) not null check(fee>0),
  nonce numeric(20,0) check(nonce>=0), last_valid_block_height bigint check(last_valid_block_height>0),
  attempts integer not null default 0 check(attempts>=0), created_at timestamptz not null default now(),
  block_number bigint check(block_number>=0), block_hash text, finalized_at timestamptz,
  primary key(job_id,phase), foreign key(job_id,chain_id) references custody_sweep_jobs(id,chain_id),
  unique(chain_id,txid), unique(chain_id,signer,nonce), check((block_number is null)=(block_hash is null)),
  check(finalized_at is null or block_hash is not null),
  check(case when chain_id='SOL' then phase='sweep' and nonce is null and last_valid_block_height is not null and txid ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
    else nonce is not null and last_valid_block_height is null and txid ~ '^0x[0-9a-f]{64}$' and signer ~ '^0x[0-9a-f]{40}$' end)
);
-- Keep ambiguous funding locked across process exits. A timeout never frees a nonce or permits a second subsidy.
create unique index custody_one_unresolved_sponsor on custody_sweep_steps(chain_id) where phase='sponsor' and finalized_at is null;
create index custody_recent_sponsorship on custody_sweep_steps(chain_id,finalized_at) where phase='sponsor';

create function custody_protect_job() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or old.status in ('completed','dust','review') or
    (new.id,new.deposit_id,new.journal_id,new.address_id,new.chain_id,new.asset_id,new.source,new.destination,new.sponsor,new.key_id,
      new.deriv_index,new.amount,new.deposit_txid,new.deposit_index,new.deposit_block,new.deposit_block_hash,new.required_conf,new.finality_conf,new.created_at)
    is distinct from (old.id,old.deposit_id,old.journal_id,old.address_id,old.chain_id,old.asset_id,old.source,old.destination,old.sponsor,old.key_id,
      old.deriv_index,old.amount,old.deposit_txid,old.deposit_index,old.deposit_block,old.deposit_block_hash,old.required_conf,old.finality_conf,old.created_at) then
    raise exception 'Immutable custody sweep';
  end if;
  if new.status='completed' and not exists(select 1 from custody_sweep_steps where job_id=new.id and phase='sweep' and finalized_at is not null) then
    raise exception 'Finalized sweep receipt required';
  end if;
  return new;
end $$;
create trigger custody_pin_job before update or delete on custody_sweep_jobs for each row execute function custody_protect_job();

create function custody_protect_step() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or
    (new.job_id,new.chain_id,new.phase,new.txid,new.raw,new.signer,new.amount,new.fee,new.nonce,new.last_valid_block_height,new.created_at)
    is distinct from (old.job_id,old.chain_id,old.phase,old.txid,old.raw,old.signer,old.amount,old.fee,old.nonce,old.last_valid_block_height,old.created_at)
    or (old.block_hash is not null and (new.block_hash,new.block_number) is distinct from (old.block_hash,old.block_number))
    or (old.finalized_at is not null and new.finalized_at is distinct from old.finalized_at) or new.attempts<old.attempts then
    raise exception 'Signed custody transaction and observed block are immutable';
  end if;
  return new;
end $$;
create trigger custody_pin_step before update or delete on custody_sweep_steps for each row execute function custody_protect_step();

-- An internal transfer cannot also become a deposit, hosted payment or withdrawal proof.
-- Take the same claim lock from either side. OLD watchers are protected during cutover too.
create index custody_deposit_hash on deposits(chain_id,lower(txid));
create index custody_invoice_hash on oxapay_transfers(chain_id,lower(txid));
create index custody_withdrawal_hash on withdrawals(chain_id,lower(txid)) where txid is not null;
create function custody_fence_transfer() returns trigger language plpgsql as $$
declare h text;
begin
  if new.txid is null or new.chain_id not in ('ETH','BSC','POL','SOL') then return new; end if;
  h:=case when new.chain_id='SOL' then new.txid else lower(new.txid) end;
  perform pg_advisory_xact_lock(hashtext('custody:transfer:'||new.chain_id),hashtext(h));
  if tg_table_name='custody_sweep_steps' then
    if exists(select 1 from deposits d where d.chain_id=new.chain_id and lower(d.txid)=lower(h) and (new.chain_id<>'SOL' or d.txid=h))
      or exists(select 1 from oxapay_transfers t where t.chain_id=new.chain_id and lower(t.txid)=lower(h) and (new.chain_id<>'SOL' or t.txid=h))
      or exists(select 1 from withdrawals w where w.chain_id=new.chain_id and lower(w.txid)=lower(h) and (new.chain_id<>'SOL' or w.txid=h)) then
      return null; -- worker treats an uninserted signed step as a manual-review conflict
    end if;
  elsif exists(select 1 from custody_sweep_steps s where s.chain_id=new.chain_id and s.txid=h) then
    if tg_op='INSERT' and tg_table_name in ('deposits','oxapay_transfers') then return null; end if;
    raise exception 'Internal custody transaction cannot be claimed';
  end if;
  return new;
end $$;
create trigger custody_claim_signed before insert on custody_sweep_steps for each row execute function custody_fence_transfer();
create trigger custody_skip_internal_deposit before insert or update of txid,chain_id,status,journal_id on deposits for each row execute function custody_fence_transfer();
create trigger custody_skip_internal_invoice before insert or update on oxapay_transfers for each row execute function custody_fence_transfer();
create trigger custody_skip_internal_withdrawal before insert or update of txid,chain_id on withdrawals for each row execute function custody_fence_transfer();

-- Do not infer ownership from an address format, an xpub, an available wallet
-- balance or an admin flag. Match the exact managed assignment and both sides
-- of the original deposit journal. Canonical transfer proof is repeated by RPC.
create index custody_credit_candidates on deposits(chain_id,id) where status='credited' and journal_id is not null and not review_hold;
create view custody_sweep_credits as
select d.id as deposit_id,d.journal_id,da.id as address_id,d.chain_id,d.asset_id,d.address as source,
       da.custody_key_id as key_id,da.deriv_index,d.amount,d.txid as deposit_txid,d.log_index as deposit_index,
       d.block_number as deposit_block,d.block_hash as deposit_block_hash,d.required_conf,
       case when d.chain_id<>'SOL' then k.fee_address end as sponsor,
       k.ready as key_ready,(n.enabled and a.enabled) as route_enabled,n.required_conf as network_conf,
       greatest(a.min_deposit,case d.asset_id when 'USDT.BEP20' then 1000000000000000000::numeric
         when 'USDT.ERC20' then 1000000 when 'USDT.POL' then 1000000 when 'SOL' then 1000000
         when 'ETH' then 2000000000000000 when 'BNB' then 10000000000000000 when 'POL' then 1000000000000000000 end) as minimum
from deposits d join deposit_addresses da on (da.chain_id,da.address,da.user_id)=(d.chain_id,d.address,d.user_id)
join custody_public_key k on k.key_id=da.custody_key_id and k.configured
join custody_launch_assets a on (a.chain_id,a.id)=(d.chain_id,d.asset_id) join chains n on n.id=d.chain_id
join journals j on j.id=d.journal_id and j.kind='deposit' and j.ref='deposit:'||d.id
where da.custody_kind='managed' and da.created_at<=d.first_seen_at and d.status='credited' and not d.review_hold
  and d.credited_at is not null and d.confirmed_at is not null and d.confirmations>=d.required_conf and d.required_conf>0
  and d.amount>0 and d.block_number>0 and da.deriv_index between 0 and 2147483647 and n.required_conf>0
  and case when d.chain_id='SOL' then d.txid ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' and d.block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' and d.log_index>=0
    else d.txid ~ '^0x[0-9a-f]{64}$' and d.block_hash ~ '^0x[0-9a-f]{64}$' and
      (case when a.kind='native' then d.log_index=-1 else d.log_index>=0 end) end
  and ((d.chain_id='SOL' and exists(select 1 from custody_sol_pool p where (p.key_id,p.deriv_index,p.address,p.user_id)=(da.custody_key_id,da.deriv_index,da.address,da.user_id)))
    or (d.chain_id in ('ETH','BSC','POL') and k.fee_address is not null and exists(select 1 from custody_evm_users p
      where (p.key_id,p.deriv_index,p.address,p.user_id)=(da.custody_key_id,da.deriv_index,da.address,da.user_id))))
  and exists(select 1 from ledger_entries e where e.journal_id=j.id and e.account='ext:'||d.chain_id and e.asset_id=d.asset_id and e.delta=-d.amount)
  and exists(select 1 from ledger_entries e where e.journal_id=j.id and e.account='u:'||d.user_id
    and e.asset_id=case when a.kind='token' then 'USDT' else d.asset_id end
    and e.delta=case when a.kind='token' then d.amount*power(10::numeric,18-a.decimals) else d.amount end)
  and not exists(select 1 from custody_sweep_steps s where s.chain_id=d.chain_id and s.txid=case when d.chain_id='SOL' then d.txid else lower(d.txid) end);

create view custody_sweep_status as
select j.id,j.deposit_id,j.chain_id,j.asset_id,j.status,s.txid,j.last_error,j.created_at,j.updated_at,j.completed_at
from custody_sweep_jobs j left join lateral (select txid from custody_sweep_steps where job_id=j.id order by (phase='sweep') desc limit 1) s on true;
create table custody_worker_health (
  chain_id text primary key references custody_sweep_networks(chain_id),
  status text not null default 'offline' check(status in ('offline','ready','paused','awaiting_key','awaiting_rpc','degraded')),
  last_error custody_sweep_reason, checked_at timestamptz
);
insert into custody_worker_health(chain_id) select chain_id from custody_sweep_networks;
