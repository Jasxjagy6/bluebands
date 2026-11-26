-- =====================================================================
-- EmpireBlox update 2: levels, wagering stats, transaction history, tips
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run on the database you already set up (it keeps all players and coins).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Player stats
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists wagered         bigint not null default 0,
  add column if not exists returned        bigint not null default 0,
  add column if not exists wager_cases     bigint not null default 0,
  add column if not exists wager_mines     bigint not null default 0,
  add column if not exists wager_battles   bigint not null default 0,
  add column if not exists cases_opened    int    not null default 0,
  add column if not exists mines_played    int    not null default 0,
  add column if not exists battles_played  int    not null default 0,
  add column if not exists rewards_claimed bigint not null default 0,
  add column if not exists tips_sent       bigint not null default 0,
  add column if not exists tips_received   bigint not null default 0;
-- Others may see your username, join date and total wagered (for your level badge) — never your coins.
grant select (id, username, created_at, wagered) on public.profiles to anon, authenticated;

-- ---------------------------------------------------------------------
-- Levels 1–100 by total coins wagered
-- 1: 0 · 2: 6,000 · 3: 16,000 · 4: 26,000 · 5: 40,000 · then each level needs 8% more than the last
-- ---------------------------------------------------------------------
create table if not exists public.levels (level int primary key, xp bigint not null);
alter table public.levels enable row level security;
drop policy if exists "levels are public" on public.levels;
create policy "levels are public" on public.levels for select using (true);
grant select on public.levels to anon, authenticated;
do $$
declare n int; x numeric := 40000;
begin
  insert into public.levels values (1, 0), (2, 6000), (3, 16000), (4, 26000), (5, 40000)
    on conflict (level) do update set xp = excluded.xp;
  for n in 6 .. 100 loop
    x := x + round(14000 * power(1.08, n - 5) / 1000) * 1000;
    insert into public.levels values (n, x) on conflict (level) do update set xp = excluded.xp;
  end loop;
end $$;

create or replace function public.level_of(p_wagered bigint)
returns int language sql stable set search_path = public as $$
  select coalesce(max(level), 1) from public.levels where xp <= p_wagered
$$;

-- ---------------------------------------------------------------------
-- Transaction history (each player only sees their own)
-- game: cases | mines | battles | tips | rewards
-- ---------------------------------------------------------------------
create table if not exists public.transactions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  game        text not null check (game in ('cases','mines','battles','tips','rewards')),
  method      text not null,
  amount      bigint not null,
  created_at  timestamptz not null default now()
);
create index if not exists transactions_user_time on public.transactions (user_id, created_at desc);
alter table public.transactions enable row level security;
drop policy if exists "see your own transactions" on public.transactions;
create policy "see your own transactions" on public.transactions for select using (user_id = auth.uid());
revoke all on public.transactions from anon, authenticated;
grant select on public.transactions to authenticated;

create or replace function public.tx(p_uid uuid, p_game text, p_method text, p_amount bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.transactions (user_id, game, method, amount) values (p_uid, p_game, p_method, p_amount)
$$;

create or replace function public.add_wager(p_uid uuid, p_game text, p_amount bigint)
returns void language sql security definer set search_path = public as $$
  update public.profiles set
    wagered        = wagered + p_amount,
    wager_cases    = wager_cases   + case when p_game = 'cases'   then p_amount else 0 end,
    wager_mines    = wager_mines   + case when p_game = 'mines'   then p_amount else 0 end,
    wager_battles  = wager_battles + case when p_game = 'battles' then p_amount else 0 end
  where id = p_uid
$$;

-- ---------------------------------------------------------------------
-- Public profile (what you see when you click someone)
-- ---------------------------------------------------------------------
create or replace function public.get_profile(p_id uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'username', p.username, 'joined', p.created_at,
    'level', public.level_of(p.wagered), 'wagered', p.wagered, 'returned', p.returned,
    'favorite', case
       when greatest(p.wager_cases, p.wager_mines, p.wager_battles) = 0 then null
       when p.wager_cases >= p.wager_mines and p.wager_cases >= p.wager_battles then 'Cases'
       when p.wager_mines >= p.wager_battles then 'Mines'
       else 'Battles' end,
    'rewards', p.rewards_claimed, 'cases_opened', p.cases_opened, 'mines_played', p.mines_played,
    'battles_played', p.battles_played, 'tips_sent', p.tips_sent, 'tips_received', p.tips_received)
  from public.profiles p where p.id = p_id
$$;

-- ---------------------------------------------------------------------
-- Tips: send play coins to another player (you must be level 2+)
-- ---------------------------------------------------------------------
create or replace function public.tip_user(p_to uuid, p_amount bigint)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_from text; v_to text; v_coins bigint; v_wagered bigint;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_to = v_uid then raise exception 'You can''t tip yourself'; end if;
  if p_amount is null or p_amount < 100 then raise exception 'The smallest tip is 100 coins'; end if;
  select username into v_to from public.profiles where id = p_to;
  if v_to is null then raise exception 'Player not found'; end if;
  select wagered into v_wagered from public.profiles where id = v_uid;
  if v_wagered < 6000 then raise exception 'Reach level 2 (6,000 coins wagered) to send tips'; end if;
  update public.profiles set coins = coins - p_amount, tips_sent = tips_sent + p_amount
   where id = v_uid and coins >= p_amount returning coins, username into v_coins, v_from;
  if not found then raise exception 'Not enough coins'; end if;
  update public.profiles set coins = coins + p_amount, tips_received = tips_received + p_amount where id = p_to;
  perform public.tx(v_uid, 'tips', 'Tip to ' || v_to, -p_amount);
  perform public.tx(p_to, 'tips', 'Tip from ' || v_from, p_amount);
  return json_build_object('coins', v_coins, 'to', v_to, 'amount', p_amount);
end $$;

-- ---------------------------------------------------------------------
-- Existing games, now also recording stats and history
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  insert into public.transactions (user_id, game, method, amount) values (new.id, 'rewards', 'Welcome bonus', 60000);
  return new;
end $$;

create or replace function public.claim_faucet()
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_coins bigint; v_at timestamptz;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  update public.profiles set coins = coins + 6000, faucet_at = now(), rewards_claimed = rewards_claimed + 6000
   where id = v_uid and (faucet_at is null or faucet_at <= now() - interval '60 seconds')
   returning coins into v_coins;
  if found then
    perform public.tx(v_uid, 'rewards', 'Free coins', 6000);
    return json_build_object('ok', true, 'coins', v_coins, 'amount', 6000);
  end if;
  select faucet_at into v_at from public.profiles where id = v_uid;
  return json_build_object('ok', false,
    'wait', greatest(1, ceil(extract(epoch from (v_at + interval '60 seconds' - now())))));
end $$;

create or replace function public.open_case(p_case text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_price bigint; v_name text; v_idx int; v_value bigint; v_item text; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select price, name into v_price, v_name from public.cases where id = p_case;
  if v_price is null then raise exception 'Unknown case'; end if;
  v_idx := public.pick_item(p_case);
  select value, name into v_value, v_item from public.case_items where case_id = p_case and idx = v_idx;
  update public.profiles set coins = coins - v_price + v_value, cases_opened = cases_opened + 1, returned = returned + v_value
   where id = v_uid and coins >= v_price returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'cases', v_price);
  perform public.tx(v_uid, 'cases', 'Opened ' || v_name, -v_price);
  perform public.tx(v_uid, 'cases', 'Unboxed ' || v_item, v_value);
  return json_build_object('idx', v_idx, 'value', v_value, 'price', v_price, 'coins', v_coins);
end $$;

create or replace function public.mines_start(p_bet bigint, p_size int, p_mines int)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_coins bigint; v_pos int[]; v_id bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  if p_size not in (16, 25, 36, 49, 64) then raise exception 'Pick a grid size'; end if;
  if p_mines < 1 or p_mines > p_size - 1 then raise exception 'Pick between 1 and % mines', p_size - 1; end if;
  if p_bet < 1 then raise exception 'Enter a bet amount'; end if;
  if exists (select 1 from public.mines_games where user_id = v_uid and status = 'active') then
    raise exception 'Finish your current game first';
  end if;
  update public.profiles set coins = coins - p_bet, mines_played = mines_played + 1
   where id = v_uid and coins >= p_bet returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'mines', p_bet);
  perform public.tx(v_uid, 'mines', 'Mines bet (' || p_mines || ' mines)', -p_bet);
  select array_agg(t) into v_pos
    from (select t from generate_series(0, p_size - 1) t order by random() limit p_mines) s;
  insert into public.mines_games (user_id, bet, size, mines, mine_positions)
  values (v_uid, p_bet, p_size, p_mines, v_pos) returning id into v_id;
  return json_build_object('id', v_id, 'coins', v_coins, 'bet', p_bet, 'size', p_size, 'mines', p_mines, 'revealed', '[]'::json);
end $$;

create or replace function public.mines_reveal(p_id bigint, p_tile int)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.mines_games; v_k int; v_pay bigint; v_coins bigint;
begin
  select * into g from public.mines_games where id = p_id and user_id = v_uid and status = 'active' for update;
  if not found then raise exception 'No active game'; end if;
  if p_tile < 0 or p_tile >= g.size then raise exception 'Bad tile'; end if;
  if p_tile = any (g.revealed) then
    return json_build_object('result', 'gem', 'revealed', g.revealed);
  end if;
  if p_tile = any (g.mine_positions) then
    update public.mines_games set status = 'lost', ended_at = now() where id = g.id;
    select coins into v_coins from public.profiles where id = v_uid;
    return json_build_object('result', 'mine', 'tile', p_tile, 'mines', g.mine_positions,
                             'revealed', g.revealed, 'coins', v_coins);
  end if;
  g.revealed := g.revealed || p_tile;
  v_k := cardinality(g.revealed);
  if v_k = g.size - g.mines then
    v_pay := floor(g.bet * public.mines_mult(v_k, g.mines, g.size));
    update public.mines_games set revealed = g.revealed, status = 'cashed', payout = v_pay, ended_at = now() where id = g.id;
    update public.profiles set coins = coins + v_pay, returned = returned + v_pay where id = v_uid returning coins into v_coins;
    perform public.tx(v_uid, 'mines', 'Mines win (board cleared)', v_pay);
    return json_build_object('result', 'cashed', 'payout', v_pay, 'mines', g.mine_positions,
                             'revealed', g.revealed, 'coins', v_coins);
  end if;
  update public.mines_games set revealed = g.revealed where id = g.id;
  return json_build_object('result', 'gem', 'revealed', g.revealed);
end $$;

create or replace function public.mines_cashout(p_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.mines_games; v_pay bigint; v_coins bigint; v_x numeric;
begin
  select * into g from public.mines_games where id = p_id and user_id = v_uid and status = 'active' for update;
  if not found then raise exception 'No active game'; end if;
  if cardinality(g.revealed) = 0 then raise exception 'Pick a tile first'; end if;
  v_x := public.mines_mult(cardinality(g.revealed), g.mines, g.size);
  v_pay := floor(g.bet * v_x);
  update public.mines_games set status = 'cashed', payout = v_pay, ended_at = now() where id = g.id;
  update public.profiles set coins = coins + v_pay, returned = returned + v_pay where id = v_uid returning coins into v_coins;
  perform public.tx(v_uid, 'mines', 'Mines cash out (' || to_char(v_x, 'FM999990.00') || '×)', v_pay);
  return json_build_object('payout', v_pay, 'multiplier', v_x, 'mines', g.mine_positions,
                           'revealed', g.revealed, 'coins', v_coins);
end $$;

create or replace function public.battle_roll(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b public.battles; n int; r int; s int; v_idx int; v_val bigint;
  v_rows jsonb := '[]'; v_row jsonb; v_tot bigint[]; v_team bigint[] := '{0,0,0}';
  v_best bigint; v_winners int := 0; v_pot bigint := 0; v_share bigint; v_pay jsonb := '[]';
begin
  select * into b from public.battles where id = p_id for update;
  n := cardinality(b.seats);
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
    v_team[public.battle_team(b.mode, s) + 1] := v_team[public.battle_team(b.mode, s) + 1] + v_tot[s];
    v_pot := v_pot + v_tot[s];
  end loop;
  select max(t) into v_best from unnest(v_team[1 : case b.mode when '2v2v2' then 3 else 2 end]) t;
  for s in 1 .. n loop
    if v_team[public.battle_team(b.mode, s) + 1] = v_best then v_winners := v_winners + 1; end if;
  end loop;
  v_share := floor(v_pot / v_winners);
  for s in 1 .. n loop
    if v_team[public.battle_team(b.mode, s) + 1] = v_best then
      v_pay := v_pay || to_jsonb(v_share);
      if b.seats[s] not like 'bot:%' then
        update public.profiles set coins = coins + v_share, returned = returned + v_share where id = b.seats[s]::uuid;
        perform public.tx(b.seats[s]::uuid, 'battles', 'Battle won (' || b.mode || ')', v_share);
      end if;
    else
      v_pay := v_pay || to_jsonb(0);
    end if;
  end loop;
  update public.battles
     set results = v_rows, payouts = v_pay, status = 'rolling', started_at = now() + interval '3 seconds'
   where id = p_id;
end $$;

create or replace function public.battle_create(p_mode text, p_cases text[])
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cost bigint; v_found int; v_coins bigint; v_id uuid; n int;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  if p_mode not in ('1v1','2v2','3v3','2v2v2') then raise exception 'Pick a mode'; end if;
  if cardinality(p_cases) is null or cardinality(p_cases) < 1 or cardinality(p_cases) > 10 then
    raise exception 'Add between 1 and 10 cases';
  end if;
  select coalesce(sum(c.price), 0), count(c.id) into v_cost, v_found
    from unnest(p_cases) u(cid) join public.cases c on c.id = u.cid;
  if v_found <> cardinality(p_cases) then raise exception 'Unknown case'; end if;
  update public.profiles set coins = coins - v_cost, battles_played = battles_played + 1
   where id = v_uid and coins >= v_cost returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', v_cost);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || p_mode || ')', -v_cost);
  n := public.battle_seats(p_mode);
  insert into public.battles (creator, mode, case_ids, cost, seats)
  values (v_uid, p_mode, p_cases, v_cost, array[v_uid::text] || array_fill(null::text, array[n - 1]))
  returning id into v_id;
  return json_build_object('id', v_id, 'coins', v_coins);
end $$;

create or replace function public.battle_join(p_id uuid, p_seat int)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if p_seat < 0 or p_seat >= cardinality(b.seats) then raise exception 'Bad seat'; end if;
  if b.seats[p_seat + 1] is not null then raise exception 'That seat was just taken'; end if;
  if v_uid::text = any (b.seats) then raise exception 'You are already in this battle'; end if;
  update public.profiles set coins = coins - b.cost, battles_played = battles_played + 1
   where id = v_uid and coins >= b.cost returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', b.cost);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || b.mode || ')', -b.cost);
  b.seats[p_seat + 1] := v_uid::text;
  update public.battles set seats = b.seats where id = p_id;
  if array_position(b.seats, null) is null then perform public.battle_roll(p_id); end if;
  return json_build_object('coins', v_coins);
end $$;

create or replace function public.battle_cancel(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; s text; v_coins bigint;
begin
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if b.creator <> v_uid then raise exception 'Only the creator can cancel'; end if;
  foreach s in array b.seats loop
    if s is not null and s not like 'bot:%' then
      update public.profiles set coins = coins + b.cost, battles_played = greatest(0, battles_played - 1) where id = s::uuid;
      perform public.add_wager(s::uuid, 'battles', -b.cost);
      perform public.tx(s::uuid, 'battles', 'Battle cancelled — refund', b.cost);
    end if;
  end loop;
  update public.battles set status = 'cancelled' where id = p_id;
  select coins into v_coins from public.profiles where id = v_uid;
  return json_build_object('coins', v_coins);
end $$;

-- ---------------------------------------------------------------------
-- Who may call what (internal helpers stay private)
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid) to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint)
  to authenticated;

-- Live updates for your own transactions (so tips you receive show up straight away)
do $$ begin
  alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null; end $$;
