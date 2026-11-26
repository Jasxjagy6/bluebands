create table if not exists game_quotes(
 id uuid primary key default gen_random_uuid(), asset_id text not null references assets(id),
 unit numeric(78,0) not null check(unit>0), expires_at timestamptz not null default now()+interval '2 minutes'
);
create index if not exists quote_asset on game_quotes(asset_id,expires_at desc);
create table if not exists instant_rounds(
 user_id uuid not null references users(id) on delete cascade, request uuid not null, game text not null,
 asset_id text references assets(id), result jsonb not null, server_seed text not null,
 client_seed text not null, nonce bigint not null, created_at timestamptz default now(), primary key(user_id,request)
);
create table if not exists battles(
 id uuid primary key, creator uuid not null references users(id), request uuid not null, asset_id text not null references assets(id),
 unit numeric(78,0) not null, cost int not null, mode text not null, case_ids text[] not null, seats text[] not null,
 crazy boolean not null, jackpot boolean not null, borrow int[] not null, status text not null default 'open',
 pf_seed text not null, pf_hash text not null, results jsonb, payouts jsonb, jp jsonb,
 created_at timestamptz not null default now(),started_at timestamptz,unique(creator,request)
);
create table if not exists player_chat(
 id bigint generated always as identity primary key,user_id uuid not null references users(id) on delete cascade,
 body text not null,created_at timestamptz not null default now()
);
create index if not exists player_chat_author on player_chat(user_id,created_at desc);
