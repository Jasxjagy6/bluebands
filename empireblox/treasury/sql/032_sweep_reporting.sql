-- Reporting never changes a signed transaction, credited amount or job state.
alter table custody_sweep_steps add column actual_fee numeric(78,0)
  check(actual_fee is null or (actual_fee>=0 and actual_fee<=fee and finalized_at is not null));
create function custody_pin_actual_fee() returns trigger language plpgsql as $$
begin
  if old.actual_fee is not null and new.actual_fee is distinct from old.actual_fee then
    raise exception 'Finalized network fee is immutable';
  end if;
  return new;
end $$;
create trigger custody_pin_actual_fee before update on custody_sweep_steps
for each row execute function custody_pin_actual_fee();

-- Read-only RPC balance snapshots are shared by every operator and API replica.
create table custody_fee_balances (
  chain_id text primary key references custody_sweep_networks(chain_id) check(chain_id<>'SOL'),
  address text, balance numeric(78,0) check(balance>=0), block_number bigint, block_hash text,
  checked_at timestamptz, attempted_at timestamptz, refresh_after timestamptz not null default '-infinity',
  last_error text check(last_error in ('unavailable','not_configured')),
  check((balance is null)=(checked_at is null))
);
insert into custody_fee_balances(chain_id) values('ETH'),('BSC'),('POL');
create index custody_sweep_history_network on custody_sweep_jobs(chain_id,id desc);
create index custody_sweep_history_status on custody_sweep_jobs(status,id desc);
