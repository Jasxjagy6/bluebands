-- One request-sized burst plus conservative request pacing is shared by API
-- replicas and the signer, preventing catch-up bursts on the dRPC free plan.
create table if not exists drpc_rpc_budget (
  singleton boolean primary key default true check (singleton),
  tokens numeric not null default 1 check (tokens >= 0 and tokens <= 1),
  updated_at timestamptz not null default clock_timestamp()
);
insert into drpc_rpc_budget(singleton) values(true) on conflict do nothing;
