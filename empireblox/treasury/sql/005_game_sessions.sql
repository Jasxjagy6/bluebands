alter table user_fair add column if not exists next_seed text not null default encode(gen_random_bytes(32),'hex');
-- Older clients received the seed at the end of a round. Retire any such
-- seed before additional rounds can start using it.
update user_fair f set server_seed=next_seed,server_seed_hash=encode(digest(next_seed,'sha256'),'hex'),
  next_seed=encode(gen_random_bytes(32),'hex')
where exists(select 1 from mines_rounds m where m.user_id=f.user_id and m.server_seed=f.server_seed);

create table if not exists blackjack_rounds (
 id uuid primary key, user_id uuid not null references users(id) on delete cascade,
 asset_id text not null references assets(id), request_id uuid not null,
 bet numeric(78,0) not null check(bet>0), shoe int[] not null, state jsonb not null,
 status text not null check(status in ('insurance','playing','done')), version int not null default 0,
 server_seed text not null, server_seed_hash text not null, client_seed text not null, nonce bigint not null,
 created_at timestamptz not null default now(), unique(user_id,request_id)
);
create unique index if not exists blackjack_one_live on blackjack_rounds(user_id) where status<>'done';
