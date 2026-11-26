-- =====================================================================
-- EmpireBlox update 14: Provably fair
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- If Supabase asks about RLS, choose "Run without RLS". Safe to run twice.
--
-- How it works
--  • Every player has a secret SERVER SEED (only its SHA-256 hash is shown),
--    a CLIENT SEED they can change, and a NONCE that goes up by 1 every bet.
--  • Every random number = first 4 bytes of HMAC-SHA256(server seed, "client:nonce:n") ÷ 2^32,
--    for n = 0, 1, 2 … — so results are fixed before you bet and can't be changed.
--  • Changing your client seed reveals the old server seed, so you can check every past bet.
--  • Case battles use their own seed per battle: the hash shows while the battle is open,
--    and the seed is revealed once it rolls (client seed = the battle id, nonce = 0).
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.pf_seeds (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  server_seed text not null,
  client_seed text not null,
  nonce       bigint not null default 0
);
create table if not exists public.pf_revealed (
  hash text primary key,
  seed text not null,
  revealed_at timestamptz not null default now()
);
create table if not exists public.pf_bets (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  game        text not null,
  client_seed text not null,
  nonce       bigint not null,
  seed_hash   text not null,
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists pf_bets_user on public.pf_bets (user_id, id desc);
create table if not exists public.battle_seeds (
  battle_id uuid primary key references public.battles(id) on delete cascade,
  seed text not null
);
alter table public.battles add column if not exists pf_hash text;
alter table public.battles add column if not exists pf_seed text;
alter table public.pf_seeds enable row level security;
alter table public.pf_revealed enable row level security;
alter table public.pf_bets enable row level security;
alter table public.battle_seeds enable row level security;
drop policy if exists "revealed seeds are public" on public.pf_revealed;
create policy "revealed seeds are public" on public.pf_revealed for select using (true);
revoke all on public.pf_seeds, public.pf_revealed, public.pf_bets, public.battle_seeds from anon, authenticated;
grant select on public.pf_revealed to anon, authenticated;

create or replace function public.pf_hash(p text)
returns text language sql immutable set search_path = public, extensions as $$ select encode(digest(p, 'sha256'), 'hex') $$;

-- next fair random number in [0, 1); falls back to random() when no seed is active
create or replace function public.pf_rand()
returns double precision language plpgsql volatile set search_path = public, extensions as $$
declare s text := current_setting('eb.pf_seed', true); c int; h bytea;
begin
  if s is null or s = '' then return random(); end if;
  c := coalesce(nullif(current_setting('eb.pf_cursor', true), ''), '0')::int;
  perform set_config('eb.pf_cursor', (c + 1)::text, true);
  h := hmac(current_setting('eb.pf_client', true) || ':' || current_setting('eb.pf_nonce', true) || ':' || c, s, 'sha256');
  return (get_byte(h, 0)::bigint * 16777216 + get_byte(h, 1) * 65536 + get_byte(h, 2) * 256 + get_byte(h, 3)) / 4294967296.0;
end $$;

create or replace function public.pf_set(p_seed text, p_client text, p_nonce bigint)
returns void language plpgsql volatile as $$
begin
  perform set_config('eb.pf_seed', coalesce(p_seed, ''), true);
  perform set_config('eb.pf_client', coalesce(p_client, ''), true);
  perform set_config('eb.pf_nonce', coalesce(p_nonce, 0)::text, true);
  perform set_config('eb.pf_cursor', '0', true);
end $$;

create or replace function public.pf_ensure(p_uid uuid)
returns public.pf_seeds language plpgsql security definer set search_path = public, extensions as $$
declare r public.pf_seeds;
begin
  insert into public.pf_seeds (user_id, server_seed, client_seed)
  values (p_uid, encode(gen_random_bytes(32), 'hex'), encode(gen_random_bytes(8), 'hex'))
  on conflict (user_id) do nothing;
  select * into r from public.pf_seeds where user_id = p_uid for update;
  return r;
end $$;

-- start a fair bet: load the player's seeds, log the bet, move the nonce on
create or replace function public.pf_begin(p_uid uuid, p_game text, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public, extensions as $$
declare r public.pf_seeds;
begin
  if p_uid is null then return; end if;
  r := public.pf_ensure(p_uid);
  perform public.pf_set(r.server_seed, r.client_seed, r.nonce);
  insert into public.pf_bets (user_id, game, client_seed, nonce, seed_hash, detail)
  values (p_uid, p_game, r.client_seed, r.nonce, public.pf_hash(r.server_seed), coalesce(p_detail, '{}'));
  update public.pf_seeds set nonce = nonce + 1 where user_id = p_uid;
end $$;

-- ---------------------------------------------------------------------
-- Point every game's randomness at pf_rand(), then wrap the games so each
-- bet starts from the player's seeds. (Rewrites the live function bodies.)
-- ---------------------------------------------------------------------
do $$
declare f text; def text;
begin
  foreach f in array array['public.pick_item(text)', 'public.pick_pack_item(integer)', 'public.open_case(text)',
    'public.mines_start(bigint,integer,integer)', 'public.upgrade(bigint,bigint,boolean)', 'public.bj_start(bigint)',
    'public.battle_roll(uuid)', 'public.claim_pack(integer)'] loop
    if to_regprocedure(f) is not null then
      def := pg_get_functiondef(to_regprocedure(f));
      if position('random()' in def) > 0 then execute replace(def, 'random()', 'public.pf_rand()'); end if;
    end if;
  end loop;
  -- rename once; the wrappers below take the original names
  if to_regprocedure('public.open_case_impl(text)') is null then alter function public.open_case(text) rename to open_case_impl; end if;
  if to_regprocedure('public.mines_start_impl(bigint,integer,integer)') is null then alter function public.mines_start(bigint, int, int) rename to mines_start_impl; end if;
  if to_regprocedure('public.upgrade_impl(bigint,bigint,boolean)') is null then alter function public.upgrade(bigint, bigint, boolean) rename to upgrade_impl; end if;
  if to_regprocedure('public.bj_start_impl(bigint)') is null then alter function public.bj_start(bigint) rename to bj_start_impl; end if;
  if to_regprocedure('public.claim_pack_impl(integer)') is null then alter function public.claim_pack(int) rename to claim_pack_impl; end if;
  if to_regprocedure('public.battle_roll_impl(uuid)') is null then alter function public.battle_roll(uuid) rename to battle_roll_impl; end if;
  if to_regprocedure('public.battle_create_impl(text,text[],boolean,boolean,integer)') is null then
    alter function public.battle_create(text, text[], boolean, boolean, int) rename to battle_create_impl; end if;
end $$;

create or replace function public.open_case(p_case text)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.pf_begin(auth.uid(), 'cases', jsonb_build_object('case', p_case));
  return public.open_case_impl(p_case);
end $$;

create or replace function public.mines_start(p_bet bigint, p_size int, p_mines int)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.pf_begin(auth.uid(), 'mines', jsonb_build_object('size', p_size, 'mines', p_mines));
  return public.mines_start_impl(p_bet, p_size, p_mines);
end $$;

create or replace function public.upgrade(p_bet bigint, p_item bigint, p_over boolean)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.pf_begin(auth.uid(), 'upgrader', jsonb_build_object('item', p_item, 'over', p_over, 'bet', p_bet));
  return public.upgrade_impl(p_bet, p_item, p_over);
end $$;

create or replace function public.bj_start(p_bet bigint)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.pf_begin(auth.uid(), 'blackjack', '{}');
  return public.bj_start_impl(p_bet);
end $$;

create or replace function public.claim_pack(p_level int)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.pf_begin(auth.uid(), 'rewards', jsonb_build_object('level', p_level));
  return public.claim_pack_impl(p_level);
end $$;

-- battles: one seed per battle, hash shown up front, seed revealed after the roll
create or replace function public.battle_create(p_mode text, p_cases text[], p_crazy boolean default false, p_jackpot boolean default false, p_borrow int default 0)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r json; s text := encode(gen_random_bytes(32), 'hex');
begin
  r := public.battle_create_impl(p_mode, p_cases, p_crazy, p_jackpot, p_borrow);
  insert into public.battle_seeds (battle_id, seed) values ((r->>'id')::uuid, s);
  update public.battles set pf_hash = public.pf_hash(s) where id = (r->>'id')::uuid;
  return r;
end $$;

create or replace function public.battle_roll(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select seed into s from public.battle_seeds where battle_id = p_id;
  if s is not null then perform public.pf_set(s, p_id::text, 0); end if;
  perform public.battle_roll_impl(p_id);
  perform public.pf_set('', '', 0);
  if s is not null then update public.battles set pf_seed = s where id = p_id; end if;
end $$;

-- ---------------------------------------------------------------------
-- What the player sees
-- ---------------------------------------------------------------------
create or replace function public.pf_state()
returns json language plpgsql volatile security definer set search_path = public as $$
declare r public.pf_seeds;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  r := public.pf_ensure(auth.uid());
  return json_build_object('hash', public.pf_hash(r.server_seed), 'client', r.client_seed, 'nonce', r.nonce);
end $$;

-- new client seed → reveals the old server seed and starts a fresh one
create or replace function public.pf_rotate(p_client text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r public.pf_seeds; v_client text := btrim(coalesce(p_client, ''));
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if v_client = '' then v_client := encode(gen_random_bytes(8), 'hex'); end if;
  if v_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'Client seed: use 1-64 letters, numbers, - or _'; end if;
  r := public.pf_ensure(auth.uid());
  insert into public.pf_revealed (hash, seed) values (public.pf_hash(r.server_seed), r.server_seed) on conflict do nothing;
  update public.pf_seeds set server_seed = encode(gen_random_bytes(32), 'hex'), client_seed = v_client, nonce = 0 where user_id = auth.uid();
  return json_build_object('revealed', r.server_seed, 'revealed_hash', public.pf_hash(r.server_seed));
end $$;

create or replace function public.pf_my_bets(p_limit int default 30)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(t order by t.id desc), '[]') from (
    select b.id, b.game, b.client_seed, b.nonce, b.seed_hash, b.detail, b.created_at, v.seed as server_seed
      from public.pf_bets b left join public.pf_revealed v on v.hash = b.seed_hash
     where b.user_id = auth.uid() order by b.id desc limit least(greatest(p_limit, 1), 100)) t
$$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[], boolean, boolean, int), public.battle_join(uuid, int, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume(),
  public.admin_stats(), public.admin_find(text), public.admin_coins(uuid, bigint), public.admin_set_admin(uuid, boolean), public.admin_delete_chat(bigint), public.admin_set_lb_hidden(uuid, boolean),
  public.pf_state(), public.pf_rotate(text), public.pf_my_bets(int)
  to authenticated;
