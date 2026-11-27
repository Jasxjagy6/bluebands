alter table alchemy_rpc_state add column if not exists routing_epoch bigint not null default 0;
