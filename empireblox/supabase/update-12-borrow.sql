-- =====================================================================
-- EmpireBlox update 12: Borrow slider for case battles
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- If Supabase asks about RLS, choose "Run without RLS". Safe to run twice.
-- Borrow X% (1–90): you pay (100−X)% of the entry and receive (100−X)% of your winnings.
-- =====================================================================
alter table public.battles add column if not exists borrow int[] not null default '{}';
update public.battles set borrow = (select array_agg(case when h then 50 else 0 end) from unnest(half) h) where cardinality(half) > 0 and cardinality(borrow) = 0;
drop function if exists public.battle_fee(bigint, boolean);

create or replace function public.battle_seats(p_mode text)
returns int language sql immutable as $$
  select case p_mode when '1v1' then 2 when 'g2' then 2 when '3way' then 3 when 'g3' then 3
                     when '4way' then 4 when '2v2' then 4 when 'g4' then 4 else 6 end
$$;
create or replace function public.battle_teams(p_mode text)
returns int language sql immutable as $$
  select case when p_mode like 'g%' then 1 when p_mode = '3way' then 3 when p_mode = '4way' then 4
              when p_mode = '2v2v2' then 3 else 2 end
$$;
create or replace function public.battle_team(p_mode text, p_seat int)   -- p_seat is 1-based, result 0-based
returns int language sql immutable as $$
  select case when p_mode like 'g%' then 0 when p_mode in ('1v1','3way','4way') then p_seat - 1
              when p_mode = '3v3' then (p_seat - 1) / 3 else (p_seat - 1) / 2 end
$$;
create or replace function public.battle_fee(p_cost bigint, p_borrow int)
returns bigint language sql immutable as $$ select ceil(p_cost * (100 - least(90, greatest(0, coalesce(p_borrow, 0)))) / 100.0)::bigint $$;

drop function if exists public.battle_create(text, text[]);
drop function if exists public.battle_create(text, text[], boolean, boolean, boolean);
create or replace function public.battle_create(p_mode text, p_cases text[], p_crazy boolean default false, p_jackpot boolean default false, p_borrow int default 0)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cost bigint; v_fee bigint; v_found int; v_coins bigint; v_id uuid; n int; v_b int[];
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  if p_mode not in ('1v1','3way','4way','2v2','3v3','2v2v2','g2','g3','g4') then raise exception 'Pick a mode'; end if;
  if cardinality(p_cases) is null or cardinality(p_cases) < 1 or cardinality(p_cases) > 20 then
    raise exception 'Add between 1 and 20 cases';
  end if;
  if p_mode like 'g%' then p_crazy := false; p_jackpot := false; end if;
  if p_crazy and p_jackpot then raise exception 'Pick Crazy or Jackpot, not both'; end if;
  select coalesce(sum(c.price), 0), count(c.id) into v_cost, v_found
    from unnest(p_cases) u(cid) join public.cases c on c.id = u.cid and c.active;
  if v_found <> cardinality(p_cases) then raise exception 'Unknown case'; end if;
  p_borrow := least(90, greatest(0, coalesce(p_borrow, 0)));
  v_fee := public.battle_fee(v_cost, p_borrow);
  update public.profiles set coins = coins - v_fee, battles_played = battles_played + 1
   where id = v_uid and coins >= v_fee returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', v_fee);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || p_mode || case when p_borrow > 0 then ', borrowed ' || p_borrow || '%' else '' end || ')', -v_fee);
  n := public.battle_seats(p_mode);
  v_b := array_fill(0, array[n]); v_b[1] := p_borrow;
  insert into public.battles (creator, mode, case_ids, cost, seats, crazy, jackpot, borrow)
  values (v_uid, p_mode, p_cases, v_cost, array[v_uid::text] || array_fill(null::text, array[n - 1]), p_crazy, p_jackpot, v_b)
  returning id into v_id;
  return json_build_object('id', v_id, 'coins', v_coins);
end $$;

drop function if exists public.battle_join(uuid, int);
drop function if exists public.battle_join(uuid, int, boolean);
create or replace function public.battle_join(p_id uuid, p_seat int, p_borrow int default 0)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; v_coins bigint; v_fee bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if p_seat < 0 or p_seat >= cardinality(b.seats) then raise exception 'Bad seat'; end if;
  if b.seats[p_seat + 1] is not null then raise exception 'That seat was just taken'; end if;
  if v_uid::text = any (b.seats) then raise exception 'You are already in this battle'; end if;
  p_borrow := least(90, greatest(0, coalesce(p_borrow, 0)));
  v_fee := public.battle_fee(b.cost, p_borrow);
  update public.profiles set coins = coins - v_fee, battles_played = battles_played + 1
   where id = v_uid and coins >= v_fee returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', v_fee);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || b.mode || case when p_borrow > 0 then ', borrowed ' || p_borrow || '%' else '' end || ')', -v_fee);
  b.seats[p_seat + 1] := v_uid::text;
  b.borrow[p_seat + 1] := p_borrow;
  update public.battles set seats = b.seats, borrow = b.borrow where id = p_id;
  if array_position(b.seats, null) is null then perform public.battle_roll(p_id); end if;
  return json_build_object('coins', v_coins);
end $$;

create or replace function public.battle_cancel(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; i int; v_fee bigint; v_coins bigint;
begin
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if b.creator <> v_uid then raise exception 'Only the creator can cancel'; end if;
  for i in 1 .. cardinality(b.seats) loop
    if b.seats[i] is not null and b.seats[i] not like 'bot:%' then
      v_fee := public.battle_fee(b.cost, b.borrow[i]);
      update public.profiles set coins = coins + v_fee, battles_played = greatest(0, battles_played - 1) where id = b.seats[i]::uuid;
      perform public.add_wager(b.seats[i]::uuid, 'battles', -v_fee);
      perform public.tx(b.seats[i]::uuid, 'battles', 'Battle cancelled — refund', v_fee);
    end if;
  end loop;
  update public.battles set status = 'cancelled' where id = p_id;
  select coins into v_coins from public.profiles where id = v_uid;
  return json_build_object('coins', v_coins);
end $$;

-- Rolls every round, picks the winners for the battle's mode, pays them, starts the animation clock.
create or replace function public.battle_roll(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b public.battles; n int; nt int; r int; s int; t int; v_idx int; v_val bigint;
  v_rows jsonb := '[]'; v_row jsonb; v_tot bigint[]; v_team bigint[] := '{0,0,0,0,0,0}';
  v_best bigint; v_wt int; v_roll numeric; v_acc numeric := 0; v_jp jsonb;
  v_winners int := 0; v_pot bigint := 0; v_share bigint; v_amt bigint; v_pay jsonb := '[]'; v_is boolean;
begin
  select * into b from public.battles where id = p_id for update;
  n := cardinality(b.seats); nt := public.battle_teams(b.mode);
  v_tot := array_fill(0::bigint, array[n]);
  for s in 1 .. n loop
    v_row := '[]';
    for r in 1 .. cardinality(b.case_ids) loop
      v_idx := public.pick_item(b.case_ids[r]);
      select value into v_val from public.case_items where case_id = b.case_ids[r] and idx = v_idx;
      v_row := v_row || to_jsonb(v_idx);
      v_tot[s] := v_tot[s] + v_val;
    end loop;
    v_rows := v_rows || jsonb_build_array(v_row);
    t := public.battle_team(b.mode, s) + 1;
    v_team[t] := v_team[t] + v_tot[s];
    v_pot := v_pot + v_tot[s];
  end loop;
  if nt > 1 and b.jackpot then
    v_roll := random();
    if v_pot = 0 then v_wt := floor(v_roll * nt)::int;
    else
      for t in 1 .. nt loop
        v_acc := v_acc + v_team[t]::numeric / v_pot;
        if v_roll < v_acc then v_wt := t - 1; exit; end if;
      end loop;
      if v_wt is null then v_wt := nt - 1; end if;
    end if;
    v_jp := jsonb_build_object('roll', v_roll, 'team', v_wt);
  elsif nt > 1 then
    if b.crazy then select min(x) into v_best from unnest(v_team[1 : nt]) x;
    else select max(x) into v_best from unnest(v_team[1 : nt]) x; end if;
  end if;
  for s in 1 .. n loop
    t := public.battle_team(b.mode, s);
    if nt = 1 or (v_jp is not null and t = v_wt) or (v_jp is null and v_team[t + 1] = v_best) then v_winners := v_winners + 1; end if;
  end loop;
  v_share := floor(v_pot / v_winners);
  for s in 1 .. n loop
    t := public.battle_team(b.mode, s);
    v_is := nt = 1 or (v_jp is not null and t = v_wt) or (v_jp is null and v_team[t + 1] = v_best);
    if v_is then
      v_amt := floor(v_share * (100 - least(90, coalesce(b.borrow[s], 0))) / 100.0);
      v_pay := v_pay || to_jsonb(v_amt);
      if b.seats[s] not like 'bot:%' and v_amt > 0 then
        update public.profiles set coins = coins + v_amt, returned = returned + v_amt where id = b.seats[s]::uuid;
        perform public.tx(b.seats[s]::uuid, 'battles', case when nt = 1 then 'Group unbox share' else 'Battle won (' || b.mode || ')' end, v_amt);
      end if;
    else
      v_pay := v_pay || to_jsonb(0);
    end if;
  end loop;
  update public.battles
     set results = v_rows, payouts = v_pay, jp = v_jp, status = 'rolling', started_at = now() + interval '3 seconds'
   where id = p_id;
end $$;


-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[], boolean, boolean, int), public.battle_join(uuid, int, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume(),
  public.admin_stats(), public.admin_find(text), public.admin_coins(uuid, bigint), public.admin_set_admin(uuid, boolean), public.admin_delete_chat(bigint), public.admin_set_lb_hidden(uuid, boolean)
  to authenticated;
