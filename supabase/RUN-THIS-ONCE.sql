-- =====================================================================
-- EmpireBlox: ALL updates in one go (2, 3, 4, 5, 6, 7)
-- For a site set up before any updates. Paste this whole file into
-- Supabase → SQL Editor → New query → Run. Run it ONE time only.
-- =====================================================================

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


-- =====================================================================
-- EmpireBlox update 3: Upgrader game + 5% house edge on every game
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Keeps all players, coins and history.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5% house edge everywhere
--   Cases:    price = average item value ÷ 0.95 (players get back 95% on average)
--   Mines:    payouts are 95% of a fair payout
--   Upgrader: win chance is 95% of a fair chance
--   Battles:  use case prices, so the same 5% applies; the winners split the whole pot
-- ---------------------------------------------------------------------
update public.cases c set price = ceil(s.ev / 0.95 / 100) * 100
  from (select case_id, sum(value * weight)::numeric / sum(weight) as ev from public.case_items group by case_id) s
 where s.case_id = c.id;

create or replace function public.mines_mult(k int, m int, n int)
returns numeric language plpgsql immutable as $$
declare x numeric := 0.95; i int;
begin
  if k = 0 then return 1; end if;
  for i in 0 .. k - 1 loop x := x * (n - i) / (n - m - i); end loop;
  return x;
end $$;

-- ---------------------------------------------------------------------
-- Upgrader items: real limiteds, valued from Rolimons Robux values
-- coins = Robux × 1.8  ($3 per 1,000 Robux, $1 = 600 coins), rounded to 100
-- ---------------------------------------------------------------------
create table if not exists public.upgrade_items (
  id     bigint primary key,          -- Roblox catalog ID (also used for the picture)
  name   text not null,
  robux  bigint not null,
  value  bigint not null              -- coins
);
alter table public.upgrade_items enable row level security;
drop policy if exists "upgrade items are public" on public.upgrade_items;
create policy "upgrade items are public" on public.upgrade_items for select using (true);
revoke all on public.upgrade_items from anon, authenticated;
grant select on public.upgrade_items to anon, authenticated;

insert into public.upgrade_items (id, name, robux, value)
select id, name, robux, greatest(100, round(robux * 1.8 / 100) * 100)
from (values
  (21070012, 'Dominus Empyreus', 110000000),
  (48545806, 'Dominus Frigidus', 90000000),
  (31101391, 'Dominus Infernus', 70000000),
  (162067148, 'Dominus Astra', 60000000),
  (259423244, 'Black Sparkle Time Fedora', 25000000),
  (1031429, 'Domino Crown', 24000000),
  (1158416, 'Eerie Pumpkin Head', 20000000),
  (63043890, 'Purple Sparkle Time Fedora', 20000000),
  (23705521, '): Euro 180', 12500000),
  (16895215, 'Darkheart', 12000000),
  (493476042, 'Sky Blue Sparkle Time Fedora', 12000000),
  (124730194, 'Blackvalk', 12000000),
  (489196035, 'Bluesteel Bling $$ Necklace', 10500000),
  (147180077, 'Teal Sparkle Time Fedora', 10000000),
  (215751161, 'Orange Sparkle Time Fedora', 9500000),
  (323417812, 'WC Ultimates: Aquamarine Attitude', 9500000),
  (335080779, 'Dominus Pittacium', 9500000),
  (32567578, 'Decklace', 9000000),
  (146134358, 'Earl of the Federation', 9000000),
  (148791559, 'Antenna Antlers', 9000000),
  (9910070, 'The Wanwood Crown', 8000000),
  (16652251, 'Red Tango', 8000000),
  (22850569, 'Red Bandana of SQL Injection', 8000000),
  (293316452, 'Archduke of the Federation', 8000000),
  (17449820, 'The Crown of Roses', 7500000),
  (20573086, '): Red Grind', 6500000),
  (26943368, 'Eccentric Shop Teacher', 6500000),
  (138932314, 'Dominus Aureus', 6000000),
  (439946249, 'Black Iron King of the Night', 6000000),
  (1114768, 'The Kleos Aphthiton', 5500000),
  (207207782, 'Lady of the Federation', 5500000),
  (31312357, 'Telamon Hair', 5000000),
  (188003914, 'Countess of the Federation', 5000000),
  (26011378, '): Star Tailslide', 4700000),
  (169444515, 'Rbadam''s Smokestack Top Hat', 4600000),
  (180660043, 'Red Glowing Eyes', 4600000),
  (2799053, 'The Golden Robloxian', 4500000),
  (250395631, 'Dominus Rex', 4400000),
  (64444871, 'Dominus Messor', 4400000),
  (439984665, 'Duchess of the Federation', 4300000),
  (144507154, 'Hooded Firelord', 4200000),
  (1323384, 'The Ice Crown', 4000000),
  (22546563, '): Gold Ollie', 4000000),
  (416832622, 'Wings of Liberty', 3600000),
  (315549204, 'WC Ultimates: Pink Diamond Distraction', 3500000),
  (14671091, 'Gaze of Socom1880', 3400000),
  (1125510, 'The Void Star', 3100000),
  (16641274, 'Illumina', 3000000),
  (31765091, 'Bharama Guardian', 3000000),
  (382880833, 'Lord of the Tixeration', 3000000),
  (183468963, 'Ghosdeeri', 2900000),
  (12908119, 'Steampunk Aetherspectacles', 2700000),
  (1285307, 'Sparkle Time Fedora', 2500000),
  (25308781, 'Chronoterminus: The Epochalypse Helm', 2500000),
  (25740034, 'Sword Cane', 2400000),
  (271015154, 'CW Ultimate: Emerald Entropy', 2400000),
  (286524947, 'CW Ultimate: Wulfinite Will', 2400000),
  (8795521, 'Gold ROBLOX Music Video Award', 2300000),
  (382881237, 'Tixvalk', 2300000),
  (382881373, 'Tix Shaggy', 2300000),
  (321346550, ':( Front Stand', 2250000),
  (215718515, 'Fiery Horns of the Netherworld', 2200000),
  (26769281, 'Masked Hood of the Doomspeaker', 2150000),
  (398676450, 'Green Glowing Eyes', 2100000),
  (228449574, 'CW Ultimate: Rose Quartz Rebellion', 2000000),
  (74891470, 'Frozen Horns of the Frigid Planes', 2000000),
  (215719463, 'Chronomalum: The Wicked Helm', 1950000),
  (17109706, 'Azurewrath, Lord of the Void', 1900000),
  (557057917, 'Interstellar Wings', 1850000),
  (14462955, 'Cultural Item', 1800000),
  (383605854, 'Pastel Rainbow Shaggy', 1800000),
  (416846000, 'Yellow Glowing Eyes', 1800000),
  (445115703, 'Goldlika: Patriot', 1800000),
  (140484519, 'Steampunk Bobbie', 1750000),
  (21070350, 'Crown of Om Nom Nom', 1700000),
  (207207025, 'Crimson Thug Shades', 1700000),
  (161211371, 'Chrononoctis: The Ominous Helm', 1550000),
  (16598513, 'Green Bow Tie', 1500000),
  (29715011, 'American Cowboy', 1500000),
  (250394771, '): Green Sidewinder', 1500000),
  (31046644, 'Crown of the Undead Hoard', 1450000),
  (33070696, 'Transient Harmonica', 1450000),
  (11748356, 'Clockwork''s Shades', 1400000),
  (17735316, 'Fire Ruby Crest', 1400000),
  (17999992, 'Eyes of Azurewrath', 1400000),
  (24487029, 'Chrysophylax', 1400000),
  (27477255, 'Red Balloon', 1400000),
  (29844011, 'Retro 80s Headphones', 1400000),
  (158069180, 'Dual Venomshanks', 1400000),
  (173783297, 'SFOTH IV Crown of Fire', 1400000),
  (188004500, 'CW Ultimate: Amethyst Addiction', 1400000),
  (321346616, 'Neon Green Crazy Crown', 1350000),
  (13793866, 'Mighty Mask of Zeus', 1300000),
  (30371876, 'Vaiobot''s Moneylicious Tie', 1250000),
  (9465511, 'Red Crown of Ozymandias', 1100000),
  (188888052, 'CW Ultimate: Sapphire Serenity', 1050000),
  (136802867, 'Hooded Frostlord', 1000000),
  (298084718, 'Dethroned Ruler of the Universe', 1000000),
  (416828455, 'Immortal Sword: The Piece Maker', 1000000),
  (568920951, 'Immortal Sword: Endless Ice Slasher', 1000000),
  (23727705, 'Spec Epsilon Biograft Energy Sword', 950000),
  (32199211, 'Chair Racing Intern', 950000),
  (25308748, 'Knightmare', 900000),
  (562478132, 'Voidwrath', 900000),
  (23301681, 'Moon Seeing Stars', 880000),
  (159229806, 'Rainbow Periastron Omega', 850000),
  (398674241, 'GoldLika: Troll', 850000),
  (13370505, 'Dark Cerulean Crown of Ozymandias', 840000),
  (135470997, 'Dr. Ishmael', 820000),
  (1235488, 'Clockwork''s Headphones', 800000),
  (15013006, 'Vlad the Impaler, IV', 800000),
  (20908915, 'A Dark Presence', 800000),
  (568921483, 'ColdLika: Snowman', 800000),
  (527365852, 'Dominus Praefectus', 790000),
  (9910420, 'Helm of the Great Tree', 750000),
  (15731113, 'Admiral of the Royal Skyfleet', 750000),
  (16646369, 'Crazy Glasses', 750000),
  (149594212, 'Fancy St. Patrick''s Fedora', 750000),
  (12908164, 'Parallel Universe Roman Empire Centurion Helmet', 730000),
  (26343188, 'Tattletale', 730000),
  (493477472, 'GoldLika: STAR', 730000),
  (14404355, 'The Dread Visage of xMaximusx', 720000),
  (14876573, 'Spec Beta Biograft Energy Sword', 700000),
  (25267538, 'Emperor', 700000),
  (209994352, 'Eyes of Emeraldwrath', 700000),
  (362032819, 'The Fire Crown', 700000),
  (152173424, 'Crown of Tones', 660000),
  (16385361, 'Cthulhu', 650000),
  (346686597, 'Rainbowrath: The Avenger', 630000),
  (376805769, 'Neon Purple Crazy Crown', 620000),
  (18482398, 'Headdress of Aken-Aten, the Sun King', 600000),
  (156105465, 'Wanwood Sombrero', 580000),
  (553971558, 'Pink Queen of the Night', 570000),
  (417458345, 'Real Flaming Hot Stunnas', 560000),
  (24112667, 'Telamon''s Chicken Suit', 550000),
  (158068251, 'Collision Top Hat', 550000),
  (26019070, 'Yum!', 540000),
  (193696233, 'Green Ice Crown', 530000),
  (258184056, 'Glorious Purple Party Queen', 520000),
  (323419455, 'Goldlika: Hero', 520000),
  (22157971, 'Helm of the Sacred Earth', 500000),
  (23962538, 'Uncle Sean''s Top Hat', 500000),
  (24114402, 'Brighteyes'' Bloxy Cola Hat', 500000),
  (24485062, 'Brighteyes'' Lavender Egg of Anticipation', 500000),
  (24826614, 'Royal Agate Egg of Beautiful Dreams', 500000),
  (439945661, 'Silver King of the Night', 470000),
  (4390891467, 'Ice Valkyrie', 410000),
  (1272714, 'Wanwood Antlers', 350000),
  (1365767, 'Valkyrie Helm', 300000),
  (1086815, 'Monstars Visor', 150000),
  (1073690, 'JJ5x5''s White Top Hat', 135000),
  (33615415, 'Picklace', 107004),
  (6552254, 'The Ice Skull of Nevermoor', 100000),
  (52492417, 'Korblox King', 93445),
  (494291269, 'Super Super Happy Face', 90000),
  (40893465, 'Even Eviler Jester', 59267),
  (32858948, 'Lava Reactor', 56559),
  (2409285794, 'Playful Vampire', 50000),
  (47597760, 'Golden Chakram of the Sky Palace', 42783),
  (35685322, 'Sundae Best', 41419),
  (38322996, 'Wildcard', 36334),
  (1172161, 'The Bluesteel Bathelm', 35000),
  (42847923, 'Sword of the Winter Winds', 32015),
  (19264845, 'Bubble Trouble', 32000),
  (25880554, 'Pin Head', 31175),
  (29051524, 'Golden Headphones', 29271),
  (22547617, 'The Crown of Nachos', 24521),
  (30394316, 'Imagine', 23016),
  (16954107, 'Viridian Hood', 22911),
  (15318156, 'Hotdog Head', 19873),
  (20980122, 'Burning Otaku, the Firesouled', 13645),
  (1285300, 'Failed Proofs of the Riemann Hypothesis', 12813),
  (23264604, 'Mick McCann', 11730),
  (27599954, 'Seeing Stars', 10367),
  (1081239, 'Bucket', 10000),
  (13476999, 'Rusty McBucketton', 9978),
  (14817131, 'Outlawed Vampumatiger Hybrid', 7661),
  (43245104, 'Jack Frost', 7617),
  (29283299, 'Kid Robot', 6930),
  (10628294, 'Mr. Quackers', 6811),
  (24441888, 'Camoface', 6694),
  (32355759, 'Bag O'' Noobs', 6569),
  (17614445, 'Hollywood Sign', 6270),
  (16723499, 'Ochre Ogre', 6030),
  (19027209, 'Perfectly Legitimate Business Hat', 6000),
  (1191812, 'Mandrake Root', 5799),
  (6548058, 'Thought Fortress', 5797),
  (10748238, 'Heat Vision Goggles', 5774),
  (10351018, 'Black Iron Warhelm of Pwnage', 5680),
  (16899436, 'Boo Visor', 5670),
  (22023239, 'Greenbot', 5667),
  (27052155, 'Cyborg Soldier', 5240),
  (48078122, 'McBrighteyes Shamrockin'' Headphones', 5204),
  (37238566, 'Robosquid', 5131),
  (15595872, 'Labor Day 2009 Gear Goggles', 4912),
  (1139753, 'Chemistry Textbook', 4861),
  (21802000, 'Sword of Nefertiti', 4781),
  (16158562, 'Sir Burnsalot', 4709),
  (26018282, 'Das Deutschlandlied', 4667),
  (5207053, 'White Witch Hat', 4034),
  (1082932, 'Traffic Cone', 4000),
  (12313606, 'Green Martian Space Helmet', 3978),
  (20044751, '2010 Party Cap', 3967),
  (1173851, 'Halloween Santa Hat', 3929),
  (9254521, 'Black Paintball Mask', 3785),
  (28039679, 'One Star General''s Beret', 3698),
  (46363235, 'For the Ages: Abraham Lincoln', 3581),
  (1048037, 'Bighead', 3500),
  (5671970, 'Gold Buckle Capotain', 3472),
  (24487396, 'O Canada', 3461),
  (1098277, 'Santa Hat', 3231),
  (9910514, 'Treehugger Visor', 3177),
  (1483632, 'Bluesteel Viking Helm of Infinite Pillage', 3166),
  (35167841, 'Ladies Who Lunch', 3113),
  (31541373, 'Beach Day', 3095),
  (14492461, 'Bloxxadore Domino Mask', 2905),
  (21802112, '27th Century Centurion', 2861),
  (14129301, 'Xenotargeting Oculus', 2860),
  (18482403, 'The Viper Band', 2782),
  (1532389, 'Invisible Egg of Shadow', 2712),
  (29532225, 'Black Lightning', 2565),
  (18729820, 'Sci-Fi Santa', 2490),
  (34111862, 'Gentlemen of Stratus', 2455),
  (48039013, 'Lucky Shades', 2381),
  (1532387, 'Golden Egg of Kings', 2334),
  (10072631, 'The Earth', 2303),
  (46363750, 'Swashbuckler', 2302),
  (17238263, 'Thunderdrone', 2275),
  (10630526, 'I Heart Mom Sign', 2273),
  (1082935, 'Headrow', 2178),
  (1136590, 'Reading Textbook', 2148),
  (49763745, 'RoBLING', 2141),
  (52180878, 'Ultimate Slide Skateboard', 2053)
) v(id, name, robux)
on conflict (id) do update set name = excluded.name, robux = excluded.robux, value = excluded.value;


-- ---------------------------------------------------------------------
-- Stats + history for the Upgrader
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists wager_upgrader  bigint not null default 0,
  add column if not exists upgrades_played int    not null default 0;
alter table public.transactions drop constraint if exists transactions_game_check;
alter table public.transactions add constraint transactions_game_check
  check (game in ('cases','mines','battles','upgrader','tips','rewards'));

create or replace function public.add_wager(p_uid uuid, p_game text, p_amount bigint)
returns void language sql security definer set search_path = public as $$
  update public.profiles set
    wagered        = wagered + p_amount,
    wager_cases    = wager_cases    + case when p_game = 'cases'    then p_amount else 0 end,
    wager_mines    = wager_mines    + case when p_game = 'mines'    then p_amount else 0 end,
    wager_battles  = wager_battles  + case when p_game = 'battles'  then p_amount else 0 end,
    wager_upgrader = wager_upgrader + case when p_game = 'upgrader' then p_amount else 0 end
  where id = p_uid
$$;

create or replace function public.get_profile(p_id uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'username', p.username, 'joined', p.created_at,
    'level', public.level_of(p.wagered), 'wagered', p.wagered, 'returned', p.returned,
    'favorite', (select g from (values ('Cases', p.wager_cases), ('Mines', p.wager_mines),
                                       ('Battles', p.wager_battles), ('Upgrader', p.wager_upgrader)) t(g, w)
                 where w > 0 order by w desc limit 1),
    'rewards', p.rewards_claimed, 'cases_opened', p.cases_opened, 'mines_played', p.mines_played,
    'battles_played', p.battles_played, 'upgrades_played', p.upgrades_played,
    'tips_sent', p.tips_sent, 'tips_received', p.tips_received)
  from public.profiles p where p.id = p_id
$$;

-- ---------------------------------------------------------------------
-- The Upgrader
--   chance (%) = bet ÷ item value × 95, capped at 80%
--   roll is 0.0000–99.9999. Roll Under wins below the chance; Roll Over wins above 100 − chance.
--   A win pays the item's value in coins.
-- ---------------------------------------------------------------------
create or replace function public.upgrade(p_bet bigint, p_item bigint, p_over boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_name text; v_value bigint; v_chance numeric; v_roll numeric; v_win boolean; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select name, value into v_name, v_value from public.upgrade_items where id = p_item;
  if v_value is null then raise exception 'Pick an item to upgrade to'; end if;
  if p_bet is null or p_bet < 1 then raise exception 'Enter a bet amount'; end if;
  if p_bet >= v_value then raise exception 'Pick an item worth more than your bet'; end if;
  v_chance := least(80, round(p_bet::numeric / v_value * 95, 4));
  if v_chance < 0.0001 then raise exception 'Chance is too small — bet more or pick a cheaper item'; end if;
  update public.profiles set coins = coins - p_bet, upgrades_played = upgrades_played + 1
   where id = v_uid and coins >= p_bet returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'upgrader', p_bet);
  perform public.tx(v_uid, 'upgrader', 'Upgrade to ' || v_name || ' (' || to_char(v_chance, 'FM990.0099') || '%)', -p_bet);
  v_roll := floor(random() * 1000000) / 10000.0;
  v_win := case when p_over then v_roll >= 100 - v_chance else v_roll < v_chance end;
  if v_win then
    update public.profiles set coins = coins + v_value, returned = returned + v_value where id = v_uid returning coins into v_coins;
    perform public.tx(v_uid, 'upgrader', 'Upgrade won: ' || v_name, v_value);
  end if;
  return json_build_object('win', v_win, 'roll', v_roll, 'chance', v_chance, 'value', v_value, 'name', v_name, 'coins', v_coins);
end $$;

-- ---------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid) to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean)
  to authenticated;


-- =====================================================================
-- EmpireBlox update 4: Rewards — a free daily pack every 10 levels
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Needs update 3 (it uses the Upgrader's item list). Keeps all players and coins.
-- =====================================================================

create table if not exists public.reward_packs (
  level  int primary key,               -- 10, 20 … 100
  name   text not null
);
create table if not exists public.reward_pack_items (
  level    int not null references public.reward_packs(level) on delete cascade,
  idx      int not null,
  item_id  bigint not null references public.upgrade_items(id),
  weight   int not null check (weight > 0),
  primary key (level, idx)
);
create table if not exists public.reward_claims (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  level       int  not null references public.reward_packs(level) on delete cascade,
  claimed_at  timestamptz not null,
  primary key (user_id, level)
);
alter table public.reward_packs      enable row level security;
alter table public.reward_pack_items enable row level security;
alter table public.reward_claims     enable row level security;
drop policy if exists "packs are public" on public.reward_packs;
drop policy if exists "pack items are public" on public.reward_pack_items;
drop policy if exists "see your own claims" on public.reward_claims;
create policy "packs are public" on public.reward_packs for select using (true);
create policy "pack items are public" on public.reward_pack_items for select using (true);
create policy "see your own claims" on public.reward_claims for select using (user_id = auth.uid());
revoke all on public.reward_packs, public.reward_pack_items, public.reward_claims from anon, authenticated;
grant select on public.reward_packs, public.reward_pack_items to anon, authenticated;
grant select on public.reward_claims to authenticated;

-- Packs and what's inside (average payout grows from ~3,000 coins at level 10 to ~3,000,000 at level 100)
insert into public.reward_packs (level, name) values
  (10, 'Bronze Pack'),
  (20, 'Steel Pack'),
  (30, 'Copper Pack'),
  (40, 'Iron Pack'),
  (50, 'Gold Pack'),
  (60, 'Jade Pack'),
  (70, 'Sapphire Pack'),
  (80, 'Ruby Pack'),
  (90, 'Amethyst Pack'),
  (100, 'Pearl Pack')
on conflict (level) do update set name = excluded.name;
delete from public.reward_pack_items;
insert into public.reward_pack_items (level, idx, item_id, weight) values
  (10, 0, 52180878, 400),
  (10, 1, 1136590, 280),
  (10, 2, 49763745, 170),
  (10, 3, 1098277, 100),
  (10, 4, 14817131, 40),
  (10, 5, 22547617, 10),
  (20, 0, 52180878, 400),
  (20, 1, 1532389, 280),
  (20, 2, 26018282, 170),
  (20, 3, 13476999, 100),
  (20, 4, 16954107, 40),
  (20, 5, 40893465, 10),
  (30, 0, 1173851, 400),
  (30, 1, 24441888, 280),
  (30, 2, 23264604, 170),
  (30, 3, 16954107, 100),
  (30, 4, 32858948, 40),
  (30, 5, 1086815, 10),
  (40, 0, 14817131, 400),
  (40, 1, 20980122, 280),
  (40, 2, 22547617, 170),
  (40, 3, 2409285794, 100),
  (40, 4, 1073690, 40),
  (40, 5, 1272714, 10),
  (50, 0, 15318156, 400),
  (50, 1, 19264845, 280),
  (50, 2, 32858948, 170),
  (50, 3, 33615415, 100),
  (50, 4, 1365767, 40),
  (50, 5, 13370505, 10),
  (60, 0, 38322996, 400),
  (60, 1, 40893465, 280),
  (60, 2, 33615415, 170),
  (60, 3, 1086815, 100),
  (60, 4, 417458345, 40),
  (60, 5, 21070350, 10),
  (70, 0, 494291269, 400),
  (70, 1, 1073690, 280),
  (70, 2, 1086815, 170),
  (70, 3, 439945661, 100),
  (70, 4, 9465511, 40),
  (70, 5, 14671091, 10),
  (80, 0, 1086815, 400),
  (80, 1, 1365767, 280),
  (80, 2, 439945661, 170),
  (80, 3, 23301681, 100),
  (80, 4, 215718515, 40),
  (80, 5, 20573086, 10),
  (90, 0, 1365767, 400),
  (90, 1, 22157971, 280),
  (90, 2, 13370505, 170),
  (90, 3, 21070350, 100),
  (90, 4, 144507154, 40),
  (90, 5, 23705521, 10),
  (100, 0, 156105465, 400),
  (100, 1, 136802867, 280),
  (100, 2, 21070350, 170),
  (100, 3, 14671091, 100),
  (100, 4, 9910070, 40),
  (100, 5, 259423244, 10);

create or replace function public.pick_pack_item(p_level int)
returns int language sql volatile set search_path = public as $$
  with c as (
    select idx, sum(weight) over (order by idx) as cum, sum(weight) over () as tot
    from public.reward_pack_items where level = p_level
  ), r as (select random() * (select max(tot) from c) as x)
  select idx from c, r where c.cum > r.x order by idx limit 1
$$;

-- Open a pack: you must be at its level, once every 24 hours per pack.
create or replace function public.claim_pack(p_level int)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_lvl int; v_last timestamptz; v_idx int; v_item bigint; v_name text; v_value bigint; v_pack text; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to open packs'; end if;
  select name into v_pack from public.reward_packs where level = p_level;
  if v_pack is null then raise exception 'Unknown pack'; end if;
  select public.level_of(wagered) into v_lvl from public.profiles where id = v_uid;
  if v_lvl < p_level then raise exception 'Reach level % to open this pack', p_level; end if;
  select claimed_at into v_last from public.reward_claims where user_id = v_uid and level = p_level for update;
  if v_last is not null and v_last > now() - interval '24 hours' then
    raise exception 'You can open this pack again in %',
      to_char((v_last + interval '24 hours') - now(), 'FMHH24"h" FMMI"m"');
  end if;
  v_idx := public.pick_pack_item(p_level);
  select i.id, i.name, i.value into v_item, v_name, v_value
    from public.reward_pack_items p join public.upgrade_items i on i.id = p.item_id
   where p.level = p_level and p.idx = v_idx;
  insert into public.reward_claims (user_id, level, claimed_at) values (v_uid, p_level, now())
  on conflict (user_id, level) do update set claimed_at = excluded.claimed_at;
  update public.profiles set coins = coins + v_value, rewards_claimed = rewards_claimed + v_value
   where id = v_uid returning coins into v_coins;
  perform public.tx(v_uid, 'rewards', 'Level ' || p_level || ' pack: ' || v_name, v_value);
  return json_build_object('idx', v_idx, 'item_id', v_item, 'name', v_name, 'value', v_value,
                           'coins', v_coins, 'next_at', now() + interval '24 hours');
end $$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid) to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int)
  to authenticated;


-- =====================================================================
-- EmpireBlox update 5: Blackjack
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Keeps all players, coins and history.
--
-- Rules: 6 decks, shuffled fresh for every hand. Dealer stands on all 17s and
-- peeks for blackjack. Double on any first two cards (also after a split).
-- Split one pair once; split aces get one card each. Insurance pays 2 to 1.
-- House edge ≈ 5%: wins pay 0.9 to 1 and blackjack pays 1.35 to 1
-- (change bj_win_mult() below to 1.0 for classic 1 to 1 / 3 to 2 payouts).
-- The deck and the dealer's hidden card never leave the server until the hand ends.
-- =====================================================================

alter table public.profiles
  add column if not exists wager_blackjack  bigint not null default 0,
  add column if not exists blackjack_played int    not null default 0;
alter table public.transactions drop constraint if exists transactions_game_check;
alter table public.transactions add constraint transactions_game_check
  check (game in ('cases','mines','battles','upgrader','blackjack','tips','rewards'));

create or replace function public.bj_win_mult() returns numeric language sql immutable as $$ select 0.9 $$;

create table if not exists public.bj_games (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  bet         bigint not null check (bet > 0),
  shoe        int[] not null,              -- cards 0–51 repeated ×6, shuffled (secret)
  pos         int not null default 0,      -- how many cards have been dealt
  dealer      int[] not null default '{}',
  h1          int[] not null default '{}',
  h2          int[],                       -- second hand after a split
  b1          bigint not null,
  b2          bigint not null default 0,
  done1       boolean not null default false,
  done2       boolean not null default false,
  active      int not null default 1,
  insurance   bigint not null default 0,
  status      text not null default 'playing' check (status in ('insurance','playing','done')),
  result1     text,
  result2     text,
  payout      bigint not null default 0,
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);
alter table public.bj_games enable row level security;
revoke all on public.bj_games from anon, authenticated;
create unique index if not exists bj_one_live on public.bj_games (user_id) where status <> 'done';

-- card helpers: rank = card % 13 (0 = A, 1–8 = 2–9, 9–12 = 10 J Q K), suit = card / 13
create or replace function public.bj_cardval(c int) returns int language sql immutable as $$
  select case when c % 13 = 0 then 11 when c % 13 <= 8 then c % 13 + 1 else 10 end
$$;
create or replace function public.bj_total(cards int[]) returns int language plpgsql immutable as $$
declare t int := 0; a int := 0; c int;
begin
  if cards is null then return 0; end if;
  foreach c in array cards loop
    t := t + public.bj_cardval(c);
    if c % 13 = 0 then a := a + 1; end if;
  end loop;
  while t > 21 and a > 0 loop t := t - 10; a := a - 1; end loop;
  return t;
end $$;
create or replace function public.bj_is_bj(cards int[]) returns boolean language sql immutable as $$
  select cardinality(cards) = 2 and public.bj_total(cards) = 21
$$;

-- What the browser is allowed to see
create or replace function public.bj_view(g public.bj_games, p_coins bigint default null)
returns json language sql stable as $$
  select json_build_object(
    'id', g.id, 'bet', g.bet, 'status', g.status, 'active', g.active,
    'dealer', case when g.status = 'done' then to_json(g.dealer) else to_json(array[g.dealer[1], -1]) end,
    'dealer_total', case when g.status = 'done' then public.bj_total(g.dealer) else public.bj_total(array[g.dealer[1]]) end,
    'hands', json_build_array(
       json_build_object('cards', g.h1, 'bet', g.b1, 'total', public.bj_total(g.h1), 'done', g.done1, 'result', g.result1)
     ) :: jsonb || case when g.h2 is null then '[]'::jsonb else jsonb_build_array(
       jsonb_build_object('cards', g.h2, 'bet', g.b2, 'total', public.bj_total(g.h2), 'done', g.done2, 'result', g.result2)) end,
    'can_double', g.status = 'playing' and cardinality(case when g.active = 1 then g.h1 else g.h2 end) = 2
                  and not (g.h2 is not null and g.h1[1] % 13 = 0),
    'can_split', g.status = 'playing' and g.h2 is null and cardinality(g.h1) = 2
                  and public.bj_cardval(g.h1[1]) = public.bj_cardval(g.h1[2]) and g.h1[1] % 13 = g.h1[2] % 13,
    'insurance', g.insurance, 'payout', g.payout, 'coins', p_coins)
$$;

-- Dealer plays out, every hand is settled and paid
create or replace function public.bj_finish(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare g public.bj_games; dv int; pv int; m numeric := public.bj_win_mult(); pay bigint := 0; h int; cards int[]; b bigint; res text; all_bust boolean;
begin
  select * into g from public.bj_games where id = p_id for update;
  all_bust := public.bj_total(g.h1) > 21 and (g.h2 is null or public.bj_total(g.h2) > 21);
  if not all_bust then
    while public.bj_total(g.dealer) < 17 loop
      g.pos := g.pos + 1; g.dealer := g.dealer || g.shoe[g.pos];
    end loop;
  end if;
  dv := public.bj_total(g.dealer);
  for h in 1 .. case when g.h2 is null then 1 else 2 end loop
    cards := case when h = 1 then g.h1 else g.h2 end;
    b := case when h = 1 then g.b1 else g.b2 end;
    pv := public.bj_total(cards);
    if pv > 21 then res := 'bust';
    elsif g.h2 is null and public.bj_is_bj(cards) and not public.bj_is_bj(g.dealer) then res := 'blackjack'; pay := pay + b + floor(b * 1.5 * m);
    elsif public.bj_is_bj(g.dealer) and not (g.h2 is null and public.bj_is_bj(cards)) then res := 'lose';
    elsif dv > 21 or pv > dv then res := 'win'; pay := pay + b + floor(b * m);
    elsif pv = dv then res := 'push'; pay := pay + b;
    else res := 'lose';
    end if;
    if h = 1 then g.result1 := res; else g.result2 := res; end if;
  end loop;
  update public.bj_games set dealer = g.dealer, pos = g.pos, result1 = g.result1, result2 = g.result2,
         done1 = true, done2 = true, status = 'done', payout = pay, ended_at = now() where id = p_id;
  if pay > 0 then
    update public.profiles set coins = coins + pay, returned = returned + pay where id = g.user_id;
    perform public.tx(g.user_id, 'blackjack', 'Blackjack win', pay);
  end if;
end $$;

create or replace function public.bj_start(p_bet bigint)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_coins bigint; v_shoe int[]; g public.bj_games;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  if p_bet is null or p_bet < 1 then raise exception 'Enter a bet amount'; end if;
  if exists (select 1 from public.bj_games where user_id = v_uid and status <> 'done') then
    raise exception 'Finish your current hand first';
  end if;
  update public.profiles set coins = coins - p_bet, blackjack_played = blackjack_played + 1
   where id = v_uid and coins >= p_bet returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'blackjack', p_bet);
  perform public.tx(v_uid, 'blackjack', 'Blackjack bet', -p_bet);
  select array_agg(c order by random()) into v_shoe from (select c % 52 as c from generate_series(0, 311) c) s;
  insert into public.bj_games (user_id, bet, shoe, pos, h1, dealer, b1)
  values (v_uid, p_bet, v_shoe, 4, array[v_shoe[1], v_shoe[3]], array[v_shoe[2], v_shoe[4]], p_bet)
  returning * into g;
  if g.dealer[1] % 13 = 0 then
    update public.bj_games set status = 'insurance' where id = g.id returning * into g;     -- dealer shows an ace
  elsif public.bj_is_bj(g.dealer) or public.bj_is_bj(g.h1) then
    perform public.bj_finish(g.id);                                                          -- dealer peeks / player blackjack
    select * into g from public.bj_games where id = g.id;
    select coins into v_coins from public.profiles where id = v_uid;
  end if;
  return public.bj_view(g, v_coins);
end $$;

-- p_action: 'insure' | 'no_insure' | 'hit' | 'stand' | 'double' | 'split'
create or replace function public.bj_act(p_id bigint, p_action text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); g public.bj_games; v_coins bigint; cards int[]; ins bigint; c int;
begin
  select * into g from public.bj_games where id = p_id and user_id = v_uid and status <> 'done' for update;
  if not found then raise exception 'No hand in play'; end if;

  if g.status = 'insurance' then
    if p_action not in ('insure', 'no_insure') then raise exception 'Choose whether to take insurance first'; end if;
    if p_action = 'insure' then
      ins := floor(g.bet / 2.0);
      if ins > 0 then
        update public.profiles set coins = coins - ins where id = v_uid and coins >= ins;
        if not found then raise exception 'Not enough coins for insurance'; end if;
        perform public.add_wager(v_uid, 'blackjack', ins);
        perform public.tx(v_uid, 'blackjack', 'Insurance', -ins);
        g.insurance := ins;
      end if;
    end if;
    if public.bj_is_bj(g.dealer) and g.insurance > 0 then
      update public.profiles set coins = coins + g.insurance * 3, returned = returned + g.insurance * 3 where id = v_uid;
      perform public.tx(v_uid, 'blackjack', 'Insurance paid 2 to 1', g.insurance * 3);
    end if;
    update public.bj_games set insurance = g.insurance, status = 'playing' where id = g.id;
    if public.bj_is_bj(g.dealer) or public.bj_is_bj(g.h1) then perform public.bj_finish(g.id); end if;

  elsif p_action = 'hit' then
    g.pos := g.pos + 1; c := g.shoe[g.pos];
    if g.active = 1 then g.h1 := g.h1 || c; cards := g.h1; else g.h2 := g.h2 || c; cards := g.h2; end if;
    update public.bj_games set pos = g.pos, h1 = g.h1, h2 = g.h2 where id = g.id;
    if public.bj_total(cards) >= 21 then perform public.bj_advance(g.id); end if;

  elsif p_action = 'stand' then
    perform public.bj_advance(g.id);

  elsif p_action = 'double' then
    cards := case when g.active = 1 then g.h1 else g.h2 end;
    if cardinality(cards) <> 2 then raise exception 'You can only double on your first two cards'; end if;
    if g.h2 is not null and g.h1[1] % 13 = 0 then raise exception 'You can''t double split aces'; end if;
    update public.profiles set coins = coins - g.bet where id = v_uid and coins >= g.bet;
    if not found then raise exception 'Not enough coins to double'; end if;
    perform public.add_wager(v_uid, 'blackjack', g.bet);
    perform public.tx(v_uid, 'blackjack', 'Double down', -g.bet);
    g.pos := g.pos + 1;
    if g.active = 1 then g.h1 := g.h1 || g.shoe[g.pos]; g.b1 := g.b1 + g.bet;
    else g.h2 := g.h2 || g.shoe[g.pos]; g.b2 := g.b2 + g.bet; end if;
    update public.bj_games set pos = g.pos, h1 = g.h1, h2 = g.h2, b1 = g.b1, b2 = g.b2 where id = g.id;
    perform public.bj_advance(g.id);

  elsif p_action = 'split' then
    if g.h2 is not null or cardinality(g.h1) <> 2 or g.h1[1] % 13 <> g.h1[2] % 13 then raise exception 'You can only split a pair'; end if;
    update public.profiles set coins = coins - g.bet where id = v_uid and coins >= g.bet;
    if not found then raise exception 'Not enough coins to split'; end if;
    perform public.add_wager(v_uid, 'blackjack', g.bet);
    perform public.tx(v_uid, 'blackjack', 'Split', -g.bet);
    g.h2 := array[g.h1[2], g.shoe[g.pos + 2]];
    g.h1 := array[g.h1[1], g.shoe[g.pos + 1]];
    g.pos := g.pos + 2; g.b2 := g.bet;
    update public.bj_games set pos = g.pos, h1 = g.h1, h2 = g.h2, b2 = g.b2 where id = g.id;
    if g.h1[1] % 13 = 0 then                                   -- split aces: one card each, then dealer plays
      update public.bj_games set done1 = true, done2 = true where id = g.id;
      perform public.bj_finish(g.id);
    elsif public.bj_total(g.h1) = 21 then perform public.bj_advance(g.id);
    end if;
  else
    raise exception 'Unknown action';
  end if;

  select * into g from public.bj_games where id = p_id;
  select coins into v_coins from public.profiles where id = v_uid;
  return public.bj_view(g, v_coins);
end $$;

-- Finish the current hand and move on (to hand 2, or to the dealer)
create or replace function public.bj_advance(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare g public.bj_games;
begin
  select * into g from public.bj_games where id = p_id for update;
  if g.active = 1 then
    update public.bj_games set done1 = true where id = p_id;
    if g.h2 is not null then
      update public.bj_games set active = 2 where id = p_id;
      if public.bj_total(g.h2) >= 21 then perform public.bj_advance(p_id); end if;
      return;
    end if;
  else
    update public.bj_games set done2 = true where id = p_id;
  end if;
  perform public.bj_finish(p_id);
end $$;

create or replace function public.bj_resume()
returns json language plpgsql stable security definer set search_path = public as $$
declare g public.bj_games;
begin
  select * into g from public.bj_games where user_id = auth.uid() and status <> 'done';
  if not found then return null; end if;
  return public.bj_view(g, null);
end $$;

-- Stats: Blackjack counts toward favourite game
create or replace function public.add_wager(p_uid uuid, p_game text, p_amount bigint)
returns void language sql security definer set search_path = public as $$
  update public.profiles set
    wagered         = wagered + p_amount,
    wager_cases     = wager_cases     + case when p_game = 'cases'     then p_amount else 0 end,
    wager_mines     = wager_mines     + case when p_game = 'mines'     then p_amount else 0 end,
    wager_battles   = wager_battles   + case when p_game = 'battles'   then p_amount else 0 end,
    wager_upgrader  = wager_upgrader  + case when p_game = 'upgrader'  then p_amount else 0 end,
    wager_blackjack = wager_blackjack + case when p_game = 'blackjack' then p_amount else 0 end
  where id = p_uid
$$;
create or replace function public.get_profile(p_id uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'username', p.username, 'joined', p.created_at,
    'level', public.level_of(p.wagered), 'wagered', p.wagered, 'returned', p.returned,
    'favorite', (select g from (values ('Cases', p.wager_cases), ('Mines', p.wager_mines), ('Battles', p.wager_battles),
                                       ('Upgrader', p.wager_upgrader), ('Blackjack', p.wager_blackjack)) t(g, w)
                 where w > 0 order by w desc limit 1),
    'rewards', p.rewards_claimed, 'cases_opened', p.cases_opened, 'mines_played', p.mines_played,
    'battles_played', p.battles_played, 'upgrades_played', p.upgrades_played, 'blackjack_played', p.blackjack_played,
    'tips_sent', p.tips_sent, 'tips_received', p.tips_received)
  from public.profiles p where p.id = p_id
$$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid) to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume()
  to authenticated;


-- =====================================================================
-- EmpireBlox update 6: Weekly wager leaderboard
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Keeps all players, coins and history.
--
-- Every coin wagered on any game counts toward this week's board.
-- Weeks run Monday 00:00 → Monday 00:00 UTC (midnight UK time in winter, 1am in summer).
-- When a week ends, the top 10 split 500,000 coins and everyone starts the new week at 0.
-- Prizes: 150K · 100K · 70K · 50K · 40K · 30K · 20K · 15K · 15K · 10K
-- Payouts happen automatically the first time anyone opens the site after the week ends.
-- =====================================================================

create table if not exists public.weekly_wagers (
  week_start  date not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  wagered     bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (week_start, user_id)
);
create index if not exists weekly_wagers_rank on public.weekly_wagers (week_start, wagered desc, updated_at);
create table if not exists public.leaderboard_weeks (
  week_start  date primary key,
  settled_at  timestamptz not null default now()
);
create table if not exists public.leaderboard_payouts (
  week_start  date not null,
  rank        int  not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  wagered     bigint not null,
  prize       bigint not null,
  primary key (week_start, rank)
);
alter table public.weekly_wagers       enable row level security;
alter table public.leaderboard_weeks   enable row level security;
alter table public.leaderboard_payouts enable row level security;
drop policy if exists "weekly wagers are public" on public.weekly_wagers;
drop policy if exists "payouts are public" on public.leaderboard_payouts;
create policy "weekly wagers are public" on public.weekly_wagers for select using (true);
create policy "payouts are public" on public.leaderboard_payouts for select using (true);
revoke all on public.weekly_wagers, public.leaderboard_weeks, public.leaderboard_payouts from anon, authenticated;
grant select on public.weekly_wagers, public.leaderboard_payouts to anon, authenticated;

create or replace function public.lb_week(ts timestamptz default now())
returns date language sql stable as $$ select date_trunc('week', ts at time zone 'UTC')::date $$;
create or replace function public.lb_prizes()
returns bigint[] language sql immutable as $$ select array[150000,100000,70000,50000,40000,30000,20000,15000,15000,10000]::bigint[] $$;

-- Every wager also counts toward this week's leaderboard
create or replace function public.add_wager(p_uid uuid, p_game text, p_amount bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set
    wagered         = wagered + p_amount,
    wager_cases     = wager_cases     + case when p_game = 'cases'     then p_amount else 0 end,
    wager_mines     = wager_mines     + case when p_game = 'mines'     then p_amount else 0 end,
    wager_battles   = wager_battles   + case when p_game = 'battles'   then p_amount else 0 end,
    wager_upgrader  = wager_upgrader  + case when p_game = 'upgrader'  then p_amount else 0 end,
    wager_blackjack = wager_blackjack + case when p_game = 'blackjack' then p_amount else 0 end
  where id = p_uid;
  insert into public.weekly_wagers (week_start, user_id, wagered, updated_at)
  values (public.lb_week(), p_uid, p_amount, now())
  on conflict (week_start, user_id) do update
    set wagered = public.weekly_wagers.wagered + excluded.wagered, updated_at = now();
end $$;

-- Pay out every finished week that hasn't been paid yet
create or replace function public.lb_settle()
returns void language plpgsql security definer set search_path = public as $$
declare w date; r record; prizes bigint[] := public.lb_prizes();
begin
  perform pg_advisory_xact_lock(424242);
  for w in
    select distinct week_start from public.weekly_wagers
     where week_start < public.lb_week()
       and week_start not in (select week_start from public.leaderboard_weeks)
     order by 1
  loop
    for r in
      select user_id, wagered, row_number() over (order by wagered desc, updated_at) as rank
        from public.weekly_wagers where week_start = w and wagered > 0
       order by wagered desc, updated_at limit 10
    loop
      insert into public.leaderboard_payouts (week_start, rank, user_id, wagered, prize)
      values (w, r.rank, r.user_id, r.wagered, prizes[r.rank]);
      update public.profiles set coins = coins + prizes[r.rank], rewards_claimed = rewards_claimed + prizes[r.rank] where id = r.user_id;
      perform public.tx(r.user_id, 'rewards', 'Weekly leaderboard #' || r.rank || ' prize', prizes[r.rank]);
    end loop;
    insert into public.leaderboard_weeks (week_start) values (w);
  end loop;
end $$;

-- This week's board (top 50), your own spot, and last week's winners
create or replace function public.get_leaderboard()
returns json language plpgsql volatile security definer set search_path = public as $$
declare w date := public.lb_week(); prizes bigint[] := public.lb_prizes(); v_me json; v_top json; v_last json;
begin
  perform public.lb_settle();
  select coalesce(json_agg(t order by t.rank), '[]') into v_top from (
    select row_number() over (order by ww.wagered desc, ww.updated_at) as rank, ww.user_id, p.username, ww.wagered,
           public.level_of(p.wagered) as level
      from public.weekly_wagers ww join public.profiles p on p.id = ww.user_id
     where ww.week_start = w and ww.wagered > 0
     order by ww.wagered desc, ww.updated_at limit 50) t;
  if auth.uid() is not null then
    select json_build_object('rank', t.rank, 'wagered', coalesce(t.wagered, 0)) into v_me from (
      select rank, wagered from (
        select user_id, wagered, row_number() over (order by wagered desc, updated_at) as rank
          from public.weekly_wagers where week_start = w and wagered > 0) x
       where user_id = auth.uid()) t;
    if v_me is null then v_me := json_build_object('rank', null, 'wagered', 0); end if;
  end if;
  select coalesce(json_agg(t order by t.rank), '[]') into v_last from (
    select lp.rank, lp.user_id, p.username, lp.wagered, lp.prize
      from public.leaderboard_payouts lp join public.profiles p on p.id = lp.user_id
     where lp.week_start = w - 7) t;
  return json_build_object('week_start', w, 'ends_at', (w + 7)::timestamp at time zone 'UTC',
                           'prizes', prizes, 'top', v_top, 'me', v_me, 'last_week', v_last);
end $$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume()
  to authenticated;


-- =====================================================================
-- EmpireBlox update 7: 30 new cases + gold dice top pulls
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Keeps all players, coins and history. The 4 old cases are retired
-- (hidden, so old battles still show), and 30 new cases take their place.
--
-- Every case: best pull ≈ 3.6× the price, 5% house edge.
-- The rarest items in each case hide behind a gold dice on the spinner;
-- landing the dice respins between just those items at their normal odds.
-- =====================================================================

alter table public.cases add column if not exists image text;
alter table public.cases add column if not exists active boolean not null default true;
alter table public.case_items add column if not exists top boolean not null default false;
grant select on public.cases, public.case_items to anon, authenticated;

update public.cases set active = false where id in ('starter','midnight','valk','dominus');
delete from public.case_items where case_id in ('blue-grin','ember','topaz','gilded-night','bubblegum-grin','pop-art','golden-snow','midnight-holly','smiley','frostbite','tropical-pop','retro-wave','sunbeam','arctic-moss','shadow-beats','neon-pop','mistletoe','lime-grin','winter-crown','violet-beats','crystal-beats','glacier','evergreen','fire-ice','black-ice','jade','sapphire','amethyst','sunset-remix','ultimate-grin');

insert into public.cases (id, name, sort, price, image, active) values
  ('blue-grin', 'Blue Grin', 100, 5200, 'assets/cases/blue-grin.webp', true),
  ('ember', 'Ember', 101, 6800, 'assets/cases/ember.webp', true),
  ('topaz', 'Topaz', 102, 12000, 'assets/cases/topaz.webp', true),
  ('gilded-night', 'Gilded Night', 103, 15000, 'assets/cases/gilded-night.webp', true),
  ('bubblegum-grin', 'Bubblegum Grin', 104, 16000, 'assets/cases/bubblegum-grin.webp', true),
  ('pop-art', 'Pop Art', 105, 18000, 'assets/cases/pop-art.webp', true),
  ('golden-snow', 'Golden Snow', 106, 21000, 'assets/cases/golden-snow.webp', true),
  ('midnight-holly', 'Midnight Holly', 107, 30000, 'assets/cases/midnight-holly.webp', true),
  ('smiley', 'Smiley', 108, 45000, 'assets/cases/smiley.webp', true),
  ('frostbite', 'Frostbite', 109, 50000, 'assets/cases/frostbite.webp', true),
  ('tropical-pop', 'Tropical Pop', 110, 68000, 'assets/cases/tropical-pop.webp', true),
  ('retro-wave', 'Retro Wave', 111, 75000, 'assets/cases/retro-wave.webp', true),
  ('sunbeam', 'Sunbeam', 112, 150000, 'assets/cases/sunbeam.webp', true),
  ('arctic-moss', 'Arctic Moss', 113, 180000, 'assets/cases/arctic-moss.webp', true),
  ('shadow-beats', 'Shadow Beats', 114, 240000, 'assets/cases/shadow-beats.webp', true),
  ('neon-pop', 'Neon Pop', 115, 310000, 'assets/cases/neon-pop.webp', true),
  ('mistletoe', 'Mistletoe', 116, 380000, 'assets/cases/mistletoe.webp', true),
  ('lime-grin', 'Lime Grin', 117, 400000, 'assets/cases/lime-grin.webp', true),
  ('winter-crown', 'Winter Crown', 118, 550000, 'assets/cases/winter-crown.webp', true),
  ('violet-beats', 'Violet Beats', 119, 700000, 'assets/cases/violet-beats.webp', true),
  ('crystal-beats', 'Crystal Beats', 120, 700000, 'assets/cases/crystal-beats.webp', true),
  ('glacier', 'Glacier', 121, 1000000, 'assets/cases/glacier.webp', true),
  ('evergreen', 'Evergreen', 122, 1000000, 'assets/cases/evergreen.webp', true),
  ('fire-ice', 'Fire Ice', 123, 1100000, 'assets/cases/fire-ice.webp', true),
  ('black-ice', 'Black Ice', 124, 2000000, 'assets/cases/black-ice.webp', true),
  ('jade', 'Jade', 125, 5000000, 'assets/cases/jade.webp', true),
  ('sapphire', 'Sapphire', 126, 6000000, 'assets/cases/sapphire.webp', true),
  ('amethyst', 'Amethyst', 127, 10000000, 'assets/cases/amethyst.webp', true),
  ('sunset-remix', 'Sunset Remix', 128, 12000000, 'assets/cases/sunset-remix.webp', true),
  ('ultimate-grin', 'Ultimate Grin', 129, 55000000, 'assets/cases/ultimate-grin.webp', true)
on conflict (id) do update set name = excluded.name, sort = excluded.sort, price = excluded.price, image = excluded.image, active = true;

insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('blue-grin', 0, 'Ultimate Slide Skateboard', 3700, 'uncommon', 146847, 52180878, 'bighead:#9aa3b8', false),
  ('blue-grin', 1, 'Headrow', 3900, 'uncommon', 144602, 1082935, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Reading Textbook', 3900, 'uncommon', 144602, 1136590, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'RoBLING', 3900, 'uncommon', 144602, 49763745, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Gentlemen of Stratus', 4400, 'uncommon', 139586, 34111862, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'rare', 129401, 1483632, 'bighead:#9aa3b8', false),
  ('blue-grin', 6, 'White Witch Hat', 7300, 'epic', 120362, 5207053, 'bighead:#9aa3b8', false),
  ('blue-grin', 7, 'Jack Frost', 13700, 'legendary', 17315, 43245104, 'bighead:#9aa3b8', true),
  ('blue-grin', 8, 'Seeing Stars', 18700, 'legendary', 12685, 27599954, 'bighead:#9aa3b8', true),
  ('ember', 0, 'Ultimate Slide Skateboard', 3700, 'common', 272833, 52180878, 'bighead:#9aa3b8', false),
  ('ember', 1, 'Black Lightning', 4600, 'uncommon', 231572, 29532225, 'bighead:#9aa3b8', false),
  ('ember', 2, 'Santa Hat', 5800, 'uncommon', 194479, 1098277, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Sir Burnsalot', 8500, 'rare', 145836, 16158562, 'bighead:#9aa3b8', false),
  ('ember', 4, 'Heat Vision Goggles', 10400, 'epic', 125280, 10748238, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 15472, 1285300, 'bighead:#9aa3b8', true),
  ('ember', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 14528, 20980122, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'Golden Egg of Kings', 4200, 'common', 145436, 1532387, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Gold Buckle Capotain', 6200, 'common', 153404, 5671970, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'White Witch Hat', 7300, 'uncommon', 156875, 5207053, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'Mandrake Root', 10400, 'uncommon', 164667, 1191812, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 171172, 14817131, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Seeing Stars', 18700, 'epic', 178446, 27599954, 'bighead:#9aa3b8', false),
  ('topaz', 6, 'Imagine', 41400, 'legendary', 15474, 30394316, 'bighead:#9aa3b8', true),
  ('topaz', 7, 'The Crown of Nachos', 44100, 'legendary', 14526, 22547617, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, 'Headrow', 3900, 'common', 143886, 1082935, 'bighead:#9aa3b8', false),
  ('gilded-night', 1, 'Black Lightning', 4600, 'common', 139839, 29532225, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Black Paintball Mask', 6800, 'common', 130702, 9254521, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'McBrighteyes Shamrockin'' Headphones', 9400, 'uncommon', 123588, 48078122, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'Kid Robot', 12500, 'uncommon', 117646, 29283299, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'Bucket', 18000, 'rare', 110460, 1081239, 'bighead:#9aa3b8', false),
  ('gilded-night', 6, 'Failed Proofs of the Riemann Hypothesis', 23100, 'epic', 105798, 1285300, 'bighead:#9aa3b8', false),
  ('gilded-night', 7, 'Hotdog Head', 35800, 'epic', 98081, 15318156, 'bighead:#9aa3b8', false),
  ('gilded-night', 8, 'Golden Headphones', 52700, 'legendary', 30000, 29051524, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, 'I Heart Mom Sign', 4100, 'common', 87989, 10630526, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 1, 'Ladies Who Lunch', 5600, 'common', 101594, 35167841, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'White Witch Hat', 7300, 'common', 114805, 5207053, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 133954, 10351018, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'Jack Frost', 13700, 'uncommon', 153474, 43245104, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Seeing Stars', 18700, 'rare', 177152, 27599954, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 6, 'Burning Otaku, the Firesouled', 24600, 'epic', 201031, 20980122, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 7, 'Pin Head', 56100, 'legendary', 15198, 25880554, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 8, 'Bubble Trouble', 57600, 'legendary', 14802, 19264845, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Black Lightning', 4600, 'common', 67593, 29532225, 'bighead:#9aa3b8', false),
  ('pop-art', 1, '2010 Party Cap', 7100, 'common', 92323, 20044751, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'Sir Burnsalot', 8500, 'common', 105065, 16158562, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Hollywood Sign', 11300, 'uncommon', 128910, 17614445, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 148812, 14817131, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Mick McCann', 21100, 'rare', 201884, 23264604, 'bighead:#9aa3b8', false),
  ('pop-art', 6, 'Burning Otaku, the Firesouled', 24600, 'rare', 225413, 20980122, 'bighead:#9aa3b8', false),
  ('pop-art', 7, 'The Bluesteel Bathelm', 63000, 'legendary', 15280, 1172161, 'bighead:#9aa3b8', true),
  ('pop-art', 8, 'Wildcard', 65400, 'legendary', 14720, 38322996, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Santa Hat', 5800, 'common', 100681, 1098277, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Halloween Santa Hat', 7100, 'common', 107965, 1173851, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Black Iron Warhelm of Pwnage', 10200, 'common', 122358, 10351018, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Jack Frost', 13700, 'uncommon', 135483, 43245104, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Bucket', 18000, 'uncommon', 148880, 1081239, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Burning Otaku, the Firesouled', 24600, 'rare', 165843, 20980122, 'bighead:#9aa3b8', false),
  ('golden-snow', 6, 'Hotdog Head', 35800, 'epic', 188791, 15318156, 'bighead:#9aa3b8', false),
  ('golden-snow', 7, 'Sword of the Winter Winds', 57600, 'legendary', 17162, 42847923, 'bighead:#9aa3b8', true),
  ('golden-snow', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12838, 47597760, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, 'Halloween Santa Hat', 7100, 'common', 75394, 1173851, 'bighead:#9aa3b8', false),
  ('midnight-holly', 1, 'Boo Visor', 10200, 'common', 92827, 16899436, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Outlawed Vampumatiger Hybrid', 13800, 'common', 110419, 14817131, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Seeing Stars', 18700, 'uncommon', 131465, 27599954, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 153881, 20980122, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Hotdog Head', 35800, 'rare', 190870, 15318156, 'bighead:#9aa3b8', false),
  ('midnight-holly', 6, 'The Crown of Nachos', 44100, 'epic', 215144, 22547617, 'bighead:#9aa3b8', false),
  ('midnight-holly', 7, 'Playful Vampire', 90000, 'legendary', 16274, 2409285794, 'bighead:#9aa3b8', true),
  ('midnight-holly', 8, 'Even Eviler Jester', 106700, 'legendary', 13726, 40893465, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Camoface', 12000, 'common', 136063, 24441888, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'Outlawed Vampumatiger Hybrid', 13800, 'common', 133783, 14817131, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'Mick McCann', 21100, 'common', 127089, 23264604, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Burning Otaku, the Firesouled', 24600, 'common', 124752, 20980122, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'Hotdog Head', 35800, 'uncommon', 119220, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Golden Headphones', 52700, 'rare', 113775, 29051524, 'bighead:#9aa3b8', false),
  ('smiley', 6, 'Wildcard', 65400, 'epic', 110843, 38322996, 'bighead:#9aa3b8', false),
  ('smiley', 7, 'Even Eviler Jester', 106700, 'epic', 104474, 40893465, 'bighead:#9aa3b8', false),
  ('smiley', 8, 'Super Super Happy Face', 162000, 'legendary', 30000, 494291269, 'bighead:#9aa3b8', true),
  ('frostbite', 0, 'Jack Frost', 13700, 'common', 90266, 43245104, 'bighead:#9aa3b8', false),
  ('frostbite', 1, 'Bucket', 18000, 'common', 102275, 1081239, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Failed Proofs of the Riemann Hypothesis', 23100, 'common', 114640, 1285300, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Hotdog Head', 35800, 'uncommon', 140086, 15318156, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Imagine', 41400, 'uncommon', 149718, 30394316, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'Sword of the Winter Winds', 57600, 'rare', 174140, 42847923, 'bighead:#9aa3b8', false),
  ('frostbite', 6, 'Golden Chakram of the Sky Palace', 77000, 'epic', 198875, 47597760, 'bighead:#9aa3b8', false),
  ('frostbite', 7, 'Korblox King', 168200, 'legendary', 15508, 52492417, 'bighead:#9aa3b8', true),
  ('frostbite', 8, 'The Ice Skull of Nevermoor', 180000, 'legendary', 14492, 6552254, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Bucket', 18000, 'common', 82678, 1081239, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'Failed Proofs of the Riemann Hypothesis', 23100, 'common', 94462, 1285300, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Hotdog Head', 35800, 'common', 119369, 15318156, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Imagine', 41400, 'uncommon', 129004, 30394316, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'Sword of the Winter Winds', 57600, 'uncommon', 153891, 42847923, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'Sundae Best', 74600, 'rare', 176688, 35685322, 'bighead:#9aa3b8', false),
  ('tropical-pop', 6, 'Even Eviler Jester', 106700, 'epic', 213908, 40893465, 'bighead:#9aa3b8', false),
  ('tropical-pop', 7, 'Picklace', 192600, 'legendary', 16736, 33615415, 'bighead:#9aa3b8', true),
  ('tropical-pop', 8, 'JJ5x5''s White Top Hat', 243000, 'legendary', 13264, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, 'Seeing Stars', 18700, 'common', 75576, 27599954, 'bighead:#9aa3b8', false),
  ('retro-wave', 1, 'Burning Otaku, the Firesouled', 24600, 'common', 89132, 20980122, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Hotdog Head', 35800, 'common', 111705, 15318156, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'The Crown of Nachos', 44100, 'uncommon', 126636, 22547617, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'The Bluesteel Bathelm', 63000, 'uncommon', 156947, 1172161, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Playful Vampire', 90000, 'rare', 194514, 2409285794, 'bighead:#9aa3b8', false),
  ('retro-wave', 6, 'Even Eviler Jester', 106700, 'epic', 215490, 40893465, 'bighead:#9aa3b8', false),
  ('retro-wave', 7, 'JJ5x5''s White Top Hat', 243000, 'legendary', 15789, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 8, 'Monstars Visor', 270000, 'legendary', 14211, 1086815, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'Hotdog Head', 35800, 'common', 146743, 15318156, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Golden Headphones', 52700, 'common', 143711, 29051524, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'Sundae Best', 74600, 'common', 141040, 35685322, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Playful Vampire', 90000, 'uncommon', 139618, 2409285794, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Korblox King', 168200, 'rare', 134983, 52492417, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'JJ5x5''s White Top Hat', 243000, 'epic', 132328, 1073690, 'bighead:#9aa3b8', false),
  ('sunbeam', 6, 'Monstars Visor', 270000, 'epic', 131578, 1086815, 'bighead:#9aa3b8', false),
  ('sunbeam', 7, 'Valkyrie Helm', 540000, 'legendary', 30000, 1365767, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'The Crown of Nachos', 44100, 'common', 69204, 22547617, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'The Bluesteel Bathelm', 63000, 'common', 88208, 1172161, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'Golden Chakram of the Sky Palace', 77000, 'common', 101109, 47597760, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Even Eviler Jester', 106700, 'uncommon', 126232, 40893465, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Super Super Happy Face', 162000, 'rare', 167701, 494291269, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'The Ice Skull of Nevermoor', 180000, 'rare', 180162, 6552254, 'bighead:#9aa3b8', false),
  ('arctic-moss', 6, 'Monstars Visor', 270000, 'epic', 237385, 1086815, 'bighead:#9aa3b8', false),
  ('arctic-moss', 7, 'Valkyrie Helm', 540000, 'legendary', 16154, 1365767, 'bighead:#9aa3b8', true),
  ('arctic-moss', 8, 'Wanwood Antlers', 630000, 'legendary', 13846, 1272714, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, 'Sword of the Winter Winds', 57600, 'common', 18357, 42847923, 'bighead:#9aa3b8', false),
  ('shadow-beats', 1, 'Playful Vampire', 90000, 'common', 46426, 2409285794, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'Even Eviler Jester', 106700, 'common', 66138, 40893465, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'Super Super Happy Face', 162000, 'uncommon', 157571, 494291269, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Picklace', 192600, 'uncommon', 225785, 33615415, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Monstars Visor', 270000, 'rare', 455723, 1086815, 'bighead:#9aa3b8', false),
  ('shadow-beats', 6, 'Ice Valkyrie', 738000, 'legendary', 16023, 4390891467, 'bighead:#9aa3b8', true),
  ('shadow-beats', 7, 'Silver King of the Night', 846000, 'legendary', 13977, 439945661, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, 'Golden Chakram of the Sky Palace', 77000, 'common', 104413, 47597760, 'bighead:#9aa3b8', false),
  ('neon-pop', 1, 'Even Eviler Jester', 106700, 'common', 121176, 40893465, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Super Super Happy Face', 162000, 'common', 146619, 494291269, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'Picklace', 192600, 'uncommon', 158667, 33615415, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'Monstars Visor', 270000, 'uncommon', 185118, 1086815, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'Valkyrie Helm', 540000, 'epic', 254008, 1365767, 'bighead:#9aa3b8', false),
  ('neon-pop', 6, 'Pink Queen of the Night', 1026000, 'legendary', 15630, 553971558, 'bighead:#9aa3b8', true),
  ('neon-pop', 7, 'Neon Purple Crazy Crown', 1116000, 'legendary', 14370, 376805769, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'Lava Reactor', 101800, 'common', 129631, 32858948, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'The Ice Skull of Nevermoor', 180000, 'common', 192314, 6552254, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'JJ5x5''s White Top Hat', 243000, 'uncommon', 236707, 1073690, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'Valkyrie Helm', 540000, 'epic', 411349, 1365767, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'Green Ice Crown', 954000, 'legendary', 17578, 193696233, 'bighead:#9aa3b8', true),
  ('mistletoe', 5, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 12422, 149594212, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Lava Reactor', 101800, 'common', 164823, 32858948, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Picklace', 192600, 'common', 215133, 33615415, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'JJ5x5''s White Top Hat', 243000, 'uncommon', 237074, 1073690, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Wanwood Antlers', 630000, 'epic', 352970, 1272714, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Crazy Glasses', 1350000, 'legendary', 15484, 16646369, 'bighead:#9aa3b8', true),
  ('lime-grin', 5, 'Clockwork''s Headphones', 1440000, 'legendary', 14516, 1235488, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, 'Super Super Happy Face', 162000, 'common', 128308, 494291269, 'bighead:#9aa3b8', false),
  ('winter-crown', 1, 'The Ice Skull of Nevermoor', 180000, 'common', 131997, 6552254, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Monstars Visor', 270000, 'common', 147213, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'Valkyrie Helm', 540000, 'rare', 177397, 1365767, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Wanwood Antlers', 630000, 'rare', 184910, 1272714, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Silver King of the Night', 846000, 'epic', 200175, 439945661, 'bighead:#9aa3b8', false),
  ('winter-crown', 6, 'Hooded Frostlord', 1800000, 'legendary', 15714, 136802867, 'bighead:#9aa3b8', true),
  ('winter-crown', 7, 'Red Crown of Ozymandias', 1980000, 'legendary', 14286, 9465511, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 197588, 6552254, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'JJ5x5''s White Top Hat', 243000, 'common', 196496, 1073690, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'Wanwood Antlers', 630000, 'rare', 193070, 1272714, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Brighteyes'' Lavender Egg of Anticipation', 900000, 'rare', 191803, 24485062, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Neon Purple Crazy Crown', 1116000, 'epic', 191042, 376805769, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'Neon Green Crazy Crown', 2430000, 'legendary', 15273, 321346616, 'bighead:#9aa3b8', true),
  ('violet-beats', 6, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 14727, 188004500, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 158265, 6552254, 'bighead:#9aa3b8', false),
  ('crystal-beats', 1, 'JJ5x5''s White Top Hat', 243000, 'common', 168255, 1073690, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'Wanwood Antlers', 630000, 'rare', 204343, 1272714, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'Ice Valkyrie', 738000, 'rare', 211046, 4390891467, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'Headdress of Aken-Aten, the Sun King', 1080000, 'epic', 228091, 18482398, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 17143, 188888052, 'bighead:#9aa3b8', true),
  ('crystal-beats', 6, 'Retro 80s Headphones', 2520000, 'legendary', 12857, 29844011, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'JJ5x5''s White Top Hat', 243000, 'common', 196512, 1073690, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'Valkyrie Helm', 540000, 'common', 153948, 1365767, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'Wanwood Antlers', 630000, 'uncommon', 146861, 1272714, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Green Ice Crown', 954000, 'rare', 129365, 193696233, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Rainbowrath: The Avenger', 1134000, 'rare', 122707, 346686597, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'ColdLika: Snowman', 1440000, 'epic', 114065, 568921483, 'bighead:#9aa3b8', false),
  ('glacier', 6, 'Hooded Frostlord', 1800000, 'epic', 106543, 136802867, 'bighead:#9aa3b8', false),
  ('glacier', 7, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 30000, 74891470, 'bighead:#9aa3b8', true),
  ('evergreen', 0, 'Monstars Visor', 270000, 'common', 160738, 1086815, 'bighead:#9aa3b8', false),
  ('evergreen', 1, 'Valkyrie Helm', 540000, 'common', 161372, 1365767, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'Wanwood Antlers', 630000, 'uncommon', 161514, 1272714, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Brighteyes'' Bloxy Cola Hat', 900000, 'rare', 161842, 24114402, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Eyes of Emeraldwrath', 1260000, 'rare', 162151, 209994352, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Knightmare', 1620000, 'epic', 162383, 25308748, 'bighead:#9aa3b8', false),
  ('evergreen', 6, 'Yellow Glowing Eyes', 3240000, 'legendary', 16154, 416846000, 'bighead:#9aa3b8', true),
  ('evergreen', 7, 'Green Glowing Eyes', 3780000, 'legendary', 13846, 398676450, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'Monstars Visor', 270000, 'common', 142444, 1086815, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'Valkyrie Helm', 540000, 'common', 154409, 1365767, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'Ice Valkyrie', 738000, 'uncommon', 160125, 4390891467, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Green Ice Crown', 954000, 'uncommon', 164981, 193696233, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'The Fire Crown', 1260000, 'rare', 170409, 362032819, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Hooded Frostlord', 1800000, 'epic', 177631, 136802867, 'bighead:#9aa3b8', false),
  ('fire-ice', 6, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 15714, 74891470, 'bighead:#9aa3b8', true),
  ('fire-ice', 7, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 14286, 215718515, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'Valkyrie Helm', 540000, 'common', 98030, 1365767, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'Ice Valkyrie', 738000, 'common', 109783, 4390891467, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Green Ice Crown', 954000, 'common', 120489, 193696233, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'A Dark Presence', 1440000, 'uncommon', 139881, 20908915, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'Voidwrath', 1620000, 'uncommon', 145983, 562478132, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Vaiobot''s Moneylicious Tie', 2250000, 'rare', 164442, 30371876, 'bighead:#9aa3b8', false),
  ('black-ice', 6, 'Azurewrath, Lord of the Void', 3420000, 'epic', 191393, 17109706, 'bighead:#9aa3b8', false),
  ('black-ice', 7, 'The Void Star', 5580000, 'legendary', 16901, 1125510, 'bighead:#9aa3b8', true),
  ('black-ice', 8, 'The Ice Crown', 7200000, 'legendary', 13099, 1323384, 'bighead:#9aa3b8', true),
  ('jade', 0, 'Eyes of Emeraldwrath', 1260000, 'common', 84825, 209994352, 'bighead:#9aa3b8', false),
  ('jade', 1, 'Spec Epsilon Biograft Energy Sword', 1710000, 'common', 98496, 23727705, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Neon Green Crazy Crown', 2430000, 'common', 116974, 321346616, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Steampunk Bobbie', 3150000, 'uncommon', 132812, 140484519, 'bighead:#9aa3b8', false),
  ('jade', 4, 'CW Ultimate: Emerald Entropy', 4320000, 'uncommon', 155009, 271015154, 'bighead:#9aa3b8', false),
  ('jade', 5, 'The Void Star', 5580000, 'rare', 175689, 1125510, 'bighead:#9aa3b8', false),
  ('jade', 6, 'Duchess of the Federation', 7740000, 'epic', 206195, 439984665, 'bighead:#9aa3b8', false),
  ('jade', 7, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 15385, 215751161, 'bighead:#9aa3b8', true),
  ('jade', 8, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 14615, 147180077, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Admiral of the Royal Skyfleet', 1350000, 'common', 73802, 15731113, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'CW Ultimate: Sapphire Serenity', 1890000, 'common', 89942, 188888052, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Eyes of Azurewrath', 2520000, 'common', 106513, 17999992, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'Azurewrath, Lord of the Void', 3420000, 'uncommon', 127456, 17109706, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Sparkle Time Fedora', 4500000, 'uncommon', 149768, 1285307, 'bighead:#9aa3b8', false),
  ('sapphire', 5, 'The Ice Crown', 7200000, 'rare', 197425, 1323384, 'bighead:#9aa3b8', false),
  ('sapphire', 6, 'Telamon Hair', 9000000, 'epic', 225095, 31312357, 'bighead:#9aa3b8', false),
  ('sapphire', 7, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 16000, 489196035, 'bighead:#9aa3b8', true),
  ('sapphire', 8, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 14000, 493476042, 'bighead:#9aa3b8', true),
  ('amethyst', 0, 'Clockwork''s Shades', 2520000, 'common', 137367, 11748356, 'bighead:#9aa3b8', false),
  ('amethyst', 1, 'Azurewrath, Lord of the Void', 3420000, 'common', 132362, 17109706, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'Sparkle Time Fedora', 4500000, 'common', 128020, 1285307, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'uncommon', 122890, 315549204, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Countess of the Federation', 9000000, 'rare', 117677, 188003914, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'Lady of the Federation', 9900000, 'rare', 116322, 207207782, 'bighead:#9aa3b8', false),
  ('amethyst', 6, 'Earl of the Federation', 16200000, 'epic', 109563, 146134358, 'bighead:#9aa3b8', false),
  ('amethyst', 7, 'Sky Blue Sparkle Time Fedora', 21600000, 'epic', 105799, 493476042, 'bighead:#9aa3b8', false),
  ('amethyst', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 30000, 63043890, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'Crown of Om Nom Nom', 3060000, 'common', 81269, 21070350, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Sparkle Time Fedora', 4500000, 'common', 99623, 1285307, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'The Void Star', 5580000, 'common', 111605, 1125510, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Dominus Rex', 7920000, 'uncommon', 134272, 250395631, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'Dominus Aureus', 10800000, 'rare', 158163, 138932314, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'The Crown of Roses', 13500000, 'rare', 177939, 17449820, 'bighead:#9aa3b8', false),
  ('sunset-remix', 6, 'Teal Sparkle Time Fedora', 18000000, 'epic', 207127, 147180077, 'bighead:#9aa3b8', false),
  ('sunset-remix', 7, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 16364, 63043890, 'bighead:#9aa3b8', true),
  ('sunset-remix', 8, 'Domino Crown', 43200000, 'legendary', 13636, 1031429, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'The Wanwood Crown', 14400000, 'common', 10460, 9910070, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'Teal Sparkle Time Fedora', 18000000, 'common', 22879, 147180077, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, '): Euro 180', 22500000, 'common', 50040, 23705521, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'Purple Sparkle Time Fedora', 36000000, 'uncommon', 260142, 63043890, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Black Sparkle Time Fedora', 45000000, 'uncommon', 568978, 259423244, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Dominus Frigidus', 162000000, 'legendary', 48125, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 6, 'Dominus Empyreus', 198000000, 'legendary', 39375, 21070012, 'bighead:#9aa3b8', true);

-- Only cases that are on sale can be opened or put in a new battle
create or replace function public.open_case(p_case text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_price bigint; v_name text; v_idx int; v_value bigint; v_item text; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select price, name into v_price, v_name from public.cases where id = p_case and active;
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
    from unnest(p_cases) u(cid) join public.cases c on c.id = u.cid and c.active;
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

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume()
  to authenticated;


