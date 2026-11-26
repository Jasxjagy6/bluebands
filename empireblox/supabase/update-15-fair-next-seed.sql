-- =====================================================================
-- EmpireBlox update 15: provably fair — next seed + safety fix
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to run twice.
--  • The next server seed is created in advance and its hash is shown, so you can
--    see the seed you'll get before you rotate.
--  • You can't rotate seeds while a Mines round or Blackjack hand is still going
--    (rotating reveals the seed, which would reveal the mines / upcoming cards).
-- =====================================================================
alter table public.pf_seeds add column if not exists next_seed text;

create or replace function public.pf_ensure(p_uid uuid)
returns public.pf_seeds language plpgsql security definer set search_path = public, extensions as $$
declare r public.pf_seeds;
begin
  insert into public.pf_seeds (user_id, server_seed, client_seed, next_seed)
  values (p_uid, encode(gen_random_bytes(32), 'hex'), encode(gen_random_bytes(8), 'hex'), encode(gen_random_bytes(32), 'hex'))
  on conflict (user_id) do nothing;
  update public.pf_seeds set next_seed = encode(gen_random_bytes(32), 'hex') where user_id = p_uid and next_seed is null;
  select * into r from public.pf_seeds where user_id = p_uid for update;
  return r;
end $$;

create or replace function public.pf_state()
returns json language plpgsql volatile security definer set search_path = public as $$
declare r public.pf_seeds;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  r := public.pf_ensure(auth.uid());
  return json_build_object('hash', public.pf_hash(r.server_seed), 'client', r.client_seed, 'nonce', r.nonce,
                           'next_hash', public.pf_hash(r.next_seed));
end $$;

create or replace function public.pf_rotate(p_client text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r public.pf_seeds; v_client text := btrim(coalesce(p_client, ''));
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from public.mines_games where user_id = auth.uid() and status = 'active') then
    raise exception 'Finish your Mines round before changing seeds'; end if;
  if exists (select 1 from public.bj_games where user_id = auth.uid() and status <> 'done') then
    raise exception 'Finish your Blackjack hand before changing seeds'; end if;
  if v_client = '' then v_client := encode(gen_random_bytes(8), 'hex'); end if;
  if v_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'Client seed: use 1-64 letters, numbers, - or _'; end if;
  r := public.pf_ensure(auth.uid());
  insert into public.pf_revealed (hash, seed) values (public.pf_hash(r.server_seed), r.server_seed) on conflict do nothing;
  update public.pf_seeds set server_seed = r.next_seed, next_seed = encode(gen_random_bytes(32), 'hex'), client_seed = v_client, nonce = 0
   where user_id = auth.uid();
  return json_build_object('revealed', r.server_seed, 'revealed_hash', public.pf_hash(r.server_seed));
end $$;

revoke execute on function public.pf_ensure(uuid) from public, anon, authenticated;
grant execute on function public.pf_state(), public.pf_rotate(text) to authenticated;

-- ---------------------------------------------------------------------
-- Crazy + Jackpot can be on together: the jackpot spin then favours the side
-- that pulled LESS (chance = everyone else's share of the pot).
-- ---------------------------------------------------------------------
do $$
declare def text;
begin
  def := pg_get_functiondef(to_regprocedure('public.battle_create_impl(text,text[],boolean,boolean,integer)'));
  if position('Pick Crazy or Jackpot, not both' in def) > 0 then
    execute replace(def, 'if p_crazy and p_jackpot then raise exception ''Pick Crazy or Jackpot, not both''; end if;', '');
  end if;
  def := pg_get_functiondef(to_regprocedure('public.battle_roll_impl(uuid)'));
  if position('v_acc := v_acc + v_team[t]::numeric / v_pot;' in def) > 0 then
    execute replace(def, 'v_acc := v_acc + v_team[t]::numeric / v_pot;',
      'v_acc := v_acc + case when b.crazy then (v_pot - v_team[t])::numeric / (v_pot * (nt - 1)) else v_team[t]::numeric / v_pot end;');
  end if;
end $$;
revoke execute on function public.battle_create_impl(text, text[], boolean, boolean, int), public.battle_roll_impl(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Bots: each empty seat gets a random bot that isn't already in the battle
-- ---------------------------------------------------------------------
create or replace function public.battle_add_bots(p_id uuid, p_seat int default null)   -- null = fill all
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; i int; pool int[]; k int;
begin
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if b.creator <> v_uid then raise exception 'Only the creator can add bots'; end if;
  select array_agg(n order by random()) into pool from generate_series(1, 5) n
   where ('bot:' || n) <> all (array_remove(b.seats, null));
  k := 1;
  for i in 1 .. cardinality(b.seats) loop
    if b.seats[i] is null and (p_seat is null or p_seat + 1 = i) then
      b.seats[i] := 'bot:' || coalesce(pool[k], (floor(random() * 5) + 1)::int); k := k + 1;
    end if;
  end loop;
  update public.battles set seats = b.seats where id = p_id;
  if array_position(b.seats, null) is null then perform public.battle_roll(p_id); end if;
end $$;
grant execute on function public.battle_add_bots(uuid, int) to authenticated;
