create table if not exists admin_sessions(
 token_hash bytea primary key,admin_id bigint not null references admin_users(id) on delete cascade,
 expires_at timestamptz not null default now()+interval '12 hours'
);
create table if not exists api_rate_limits(
 ip text not null,route text not null,window_start timestamptz not null,hits int not null,primary key(ip,route)
);
alter table mines_rounds add column if not exists request_id uuid;
create unique index if not exists mines_request on mines_rounds(user_id,request_id);
create sequence if not exists evm_receive_index minvalue 0 start with 0;
select setval('evm_receive_index',coalesce((select max(d.deriv_index)+1 from deposit_addresses d join chains c on c.id=d.chain_id where c.kind='evm'),0),false);
create table if not exists evm_receive_users(user_id uuid primary key,deriv_index bigint unique not null);
