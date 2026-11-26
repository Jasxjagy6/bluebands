-- =====================================================================
-- EmpireBlox — Supabase database
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query
-- → paste → Run. It is safe to run on a fresh project only.
--
-- Everything that changes coins happens inside the functions below, on the
-- server, so players can't give themselves coins from the browser.
-- Coins are play money only: nothing here can be bought, sold or withdrawn.
-- =====================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    citext not null unique check (username ~ '^[A-Za-z0-9_]{2,20}$'),
  coins       bigint not null default 60000 check (coins >= 0),
  faucet_at   timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "anyone can read usernames" on public.profiles for select using (true);
-- Only id + username are readable by others; coins come from my_profile().
revoke all on public.profiles from anon, authenticated;
grant select (id, username, created_at) on public.profiles to anon, authenticated;

-- When someone signs up, make their profile from the username they chose.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.username_available(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_name ~ '^[A-Za-z0-9_]{2,20}$'
     and not exists (select 1 from public.profiles where username = p_name::citext)
$$;

create or replace function public.my_profile()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', id, 'username', username, 'coins', coins, 'faucet_at', faucet_at)
  from public.profiles where id = auth.uid()
$$;

create or replace function public.set_username(p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_name !~ '^[A-Za-z0-9_]{2,20}$' then raise exception 'Use 2-20 letters, numbers or underscores'; end if;
  if exists (select 1 from public.profiles where username = p_name::citext and id <> auth.uid()) then
    raise exception 'That username is taken';
  end if;
  update public.profiles set username = p_name where id = auth.uid();
end $$;

-- Free coins once a minute.
create or replace function public.claim_faucet()
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_coins bigint; v_at timestamptz;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  update public.profiles set coins = coins + 6000, faucet_at = now()
   where id = v_uid and (faucet_at is null or faucet_at <= now() - interval '60 seconds')
   returning coins into v_coins;
  if found then return json_build_object('ok', true, 'coins', v_coins, 'amount', 6000); end if;
  select faucet_at into v_at from public.profiles where id = v_uid;
  return json_build_object('ok', false,
    'wait', greatest(1, ceil(extract(epoch from (v_at + interval '60 seconds' - now())))));
end $$;

-- ---------------------------------------------------------------------
-- Cases and items (values: $10 = 6,000 coins)
-- ---------------------------------------------------------------------
create table public.cases (
  id     text primary key,
  name   text not null,
  sort   int  not null,
  price  bigint not null default 0
);
create table public.case_items (
  case_id    text not null references public.cases(id) on delete cascade,
  idx        int  not null,
  name       text not null,
  value      bigint not null,
  rarity     text not null check (rarity in ('common','uncommon','rare','epic','legendary')),
  weight     int  not null check (weight > 0),
  catalog_id bigint not null default 0,
  art        text not null,
  primary key (case_id, idx)
);
alter table public.cases enable row level security;
alter table public.case_items enable row level security;
create policy "cases are public" on public.cases for select using (true);
create policy "items are public" on public.case_items for select using (true);
revoke all on public.cases, public.case_items from anon, authenticated;
grant select on public.cases, public.case_items to anon, authenticated;

-- Weighted random pick of one item index from a case.
create or replace function public.pick_item(p_case text)
returns int language sql volatile set search_path = public as $$
  with c as (
    select idx, sum(weight) over (order by idx) as cum, sum(weight) over () as tot
    from public.case_items where case_id = p_case
  ), r as (select random() * (select max(tot) from c) as x)
  select idx from c, r where c.cum > r.x order by idx limit 1
$$;

create or replace function public.open_case(p_case text)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_price bigint; v_idx int; v_value bigint; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select price into v_price from public.cases where id = p_case;
  if v_price is null then raise exception 'Unknown case'; end if;
  v_idx := public.pick_item(p_case);
  select value into v_value from public.case_items where case_id = p_case and idx = v_idx;
  update public.profiles set coins = coins - v_price + v_value
   where id = v_uid and coins >= v_price returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  return json_build_object('idx', v_idx, 'value', v_value, 'price', v_price, 'coins', v_coins);
end $$;

-- ---------------------------------------------------------------------
-- Mines (mine positions never leave the server until the round ends)
-- ---------------------------------------------------------------------
create table public.mines_games (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  bet            bigint not null check (bet > 0),
  size           int not null check (size in (16, 25, 36, 49, 64)),
  mines          int not null,
  mine_positions int[] not null,
  revealed       int[] not null default '{}',
  status         text not null default 'active' check (status in ('active','lost','cashed')),
  payout         bigint not null default 0,
  created_at     timestamptz not null default now(),
  ended_at       timestamptz
);
alter table public.mines_games enable row level security;
revoke all on public.mines_games from anon, authenticated;
create unique index mines_one_active on public.mines_games (user_id) where status = 'active';

create or replace function public.mines_mult(k int, m int, n int)
returns numeric language plpgsql immutable as $$
declare x numeric := 0.97; i int;
begin
  if k = 0 then return 1; end if;
  for i in 0 .. k - 1 loop x := x * (n - i) / (n - m - i); end loop;
  return x;
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
  update public.profiles set coins = coins - p_bet where id = v_uid and coins >= p_bet returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
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
    update public.profiles set coins = coins + v_pay where id = v_uid returning coins into v_coins;
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
  update public.profiles set coins = coins + v_pay where id = v_uid returning coins into v_coins;
  return json_build_object('payout', v_pay, 'multiplier', v_x, 'mines', g.mine_positions,
                           'revealed', g.revealed, 'coins', v_coins);
end $$;

create or replace function public.mines_resume()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', id, 'bet', bet, 'size', size, 'mines', mines, 'revealed', revealed)
  from public.mines_games where user_id = auth.uid() and status = 'active'
$$;

-- ---------------------------------------------------------------------
-- Case battles: 1v1, 2v2, 3v3, 2v2v2. The winning team splits the pot.
-- Seats hold a player id, 'bot:N', or null while empty.
-- ---------------------------------------------------------------------
create table public.battles (
  id          uuid primary key default gen_random_uuid(),
  creator     uuid not null references public.profiles(id) on delete cascade,
  mode        text not null check (mode in ('1v1','2v2','3v3','2v2v2')),
  case_ids    text[] not null check (cardinality(case_ids) between 1 and 10),
  cost        bigint not null,
  seats       text[] not null,
  status      text not null default 'open' check (status in ('open','rolling','cancelled')),
  results     jsonb,   -- [[item index per round] per seat]
  payouts     jsonb,   -- [coins won per seat]
  started_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.battles enable row level security;
create policy "battles are public" on public.battles for select using (true);
revoke all on public.battles from anon, authenticated;
grant select on public.battles to anon, authenticated;
create index battles_created on public.battles (created_at desc);
create index battles_seats on public.battles using gin (seats);

create or replace function public.battle_seats(p_mode text)
returns int language sql immutable as $$
  select case p_mode when '1v1' then 2 when '2v2' then 4 else 6 end
$$;
create or replace function public.battle_team(p_mode text, p_seat int)   -- p_seat is 1-based
returns int language sql immutable as $$
  select case p_mode when '1v1' then p_seat - 1 when '3v3' then (p_seat - 1) / 3 else (p_seat - 1) / 2 end
$$;

-- Rolls every round, pays the winning team and starts the animation clock.
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
        update public.profiles set coins = coins + v_share where id = b.seats[s]::uuid;
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
  update public.profiles set coins = coins - v_cost where id = v_uid and coins >= v_cost returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  n := public.battle_seats(p_mode);
  insert into public.battles (creator, mode, case_ids, cost, seats)
  values (v_uid, p_mode, p_cases, v_cost, array[v_uid::text] || array_fill(null::text, array[n - 1]))
  returning id into v_id;
  return json_build_object('id', v_id, 'coins', v_coins);
end $$;

create or replace function public.battle_join(p_id uuid, p_seat int)   -- p_seat is 0-based
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; v_coins bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if p_seat < 0 or p_seat >= cardinality(b.seats) then raise exception 'Bad seat'; end if;
  if b.seats[p_seat + 1] is not null then raise exception 'That seat was just taken'; end if;
  if v_uid::text = any (b.seats) then raise exception 'You are already in this battle'; end if;
  update public.profiles set coins = coins - b.cost where id = v_uid and coins >= b.cost returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  b.seats[p_seat + 1] := v_uid::text;
  update public.battles set seats = b.seats where id = p_id;
  if array_position(b.seats, null) is null then perform public.battle_roll(p_id); end if;
  return json_build_object('coins', v_coins);
end $$;

create or replace function public.battle_add_bots(p_id uuid, p_seat int default null)   -- null = fill all
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; i int; k int;
begin
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if b.creator <> v_uid then raise exception 'Only the creator can add bots'; end if;
  select count(*) + 1 into k from unnest(b.seats) s where s like 'bot:%';
  for i in 1 .. cardinality(b.seats) loop
    if b.seats[i] is null and (p_seat is null or p_seat + 1 = i) then
      b.seats[i] := 'bot:' || k; k := k + 1;
    end if;
  end loop;
  update public.battles set seats = b.seats where id = p_id;
  if array_position(b.seats, null) is null then perform public.battle_roll(p_id); end if;
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
      update public.profiles set coins = coins + b.cost where id = s::uuid;
    end if;
  end loop;
  update public.battles set status = 'cancelled' where id = p_id;
  select coins into v_coins from public.profiles where id = v_uid;
  return json_build_object('coins', v_coins);
end $$;

-- ---------------------------------------------------------------------
-- Live chat (3-second slowmode, keeps the latest 500 messages)
-- ---------------------------------------------------------------------
create table public.chat_messages (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  username    text not null,
  body        text not null check (char_length(body) between 1 and 200),
  created_at  timestamptz not null default now()
);
alter table public.chat_messages enable row level security;
create policy "chat is public" on public.chat_messages for select using (true);
revoke all on public.chat_messages from anon, authenticated;
grant select on public.chat_messages to anon, authenticated;

create or replace function public.send_chat(p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_name text; v_body text := btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g'));
begin
  if v_uid is null then raise exception 'Sign in to chat'; end if;
  if char_length(v_body) = 0 then return; end if;
  if char_length(v_body) > 200 then raise exception 'Keep messages under 200 characters'; end if;
  if exists (select 1 from public.chat_messages where user_id = v_uid and created_at > now() - interval '3 seconds') then
    raise exception 'Slowmode — wait a few seconds';
  end if;
  select username into v_name from public.profiles where id = v_uid;
  insert into public.chat_messages (user_id, username, body) values (v_uid, v_name, v_body);
  delete from public.chat_messages where id <= (select max(id) - 500 from public.chat_messages);
end $$;


-- ---------------------------------------------------------------------
-- Seed: cases and items (art = how the page draws the item)
-- ---------------------------------------------------------------------
insert into public.cases (id, name, sort) values
  ('starter', 'Starter Limiteds', 0),
  ('midnight', 'Midnight Case', 1),
  ('valk', 'Valk Vault', 2),
  ('dominus', 'Dominus Case', 3);
insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art) values
  ('starter', 0, 'Bighead', 6300, 'common', 400, 1048037, 'bighead:#c9ccd6'),
  ('starter', 1, 'Perfectly Legitimate Business Hat', 10800, 'common', 300, 19027209, 'tophat:#2a2a35:#3ddc84'),
  ('starter', 2, 'Gold Clockwork Headphones', 12600, 'uncommon', 170, 0, 'phones:#ffc93c:#7a5200'),
  ('starter', 3, 'Bluesteel Bathelm', 63000, 'rare', 90, 1172161, 'helm:#7fa6d6'),
  ('starter', 4, 'Playful Vampire', 90000, 'epic', 30, 2409285794, 'vampire'),
  ('starter', 5, 'Super Super Happy Face', 162000, 'legendary', 10, 494291269, 'face:#ffd23f'),
  ('midnight', 0, 'Violet Valkyrie', 90000, 'common', 380, 0, 'helm:#9b5cff:#e5d6ff'),
  ('midnight', 1, 'Midnight Shades', 270000, 'common', 280, 0, 'shades:#15172a:#252b52'),
  ('midnight', 2, 'Valkyrie Helm', 540000, 'uncommon', 190, 1365767, 'helm:#c7ccd6:#f2f4f8'),
  ('midnight', 3, 'Wanwood Antlers', 630000, 'rare', 100, 1272714, 'antlers:#a36c3c'),
  ('midnight', 4, 'Silver King of the Night', 846000, 'epic', 40, 439945661, 'crown:#d3d8e6:#5b6cff'),
  ('midnight', 5, 'Sparkle Time Fedora', 4500000, 'legendary', 10, 1285307, 'fedora:#2fb5a8:#0d3b37:#d2fff8'),
  ('valk', 0, 'Ice Valkyrie', 738000, 'common', 380, 4390891467, 'helm:#8fd3ff:#e3f6ff'),
  ('valk', 1, 'Dominus Praefectus', 1422000, 'common', 280, 527365852, 'hood:#e6dfca:#ffc93c:#7fd7ff'),
  ('valk', 2, 'Clockwork''s Headphones', 1800000, 'uncommon', 190, 1235488, 'phones:#c98a3d:#5a3a1a'),
  ('valk', 3, 'Frozen Horns of the Frigid Planes', 3600000, 'rare', 100, 74891470, 'horns:#bfe9ff:#6fc8ff'),
  ('valk', 4, 'Fiery Horns of the Netherworld', 3960000, 'epic', 40, 215718515, 'horns:#ff5a2a:#ffc13c'),
  ('valk', 5, 'Blackvalk', 21600000, 'legendary', 10, 124730194, 'helm:#22242e:#41455a'),
  ('dominus', 0, 'Dominus Messor', 7920000, 'common', 400, 64444871, 'hood:#2b2b30:#6a6a75:#ff5470'),
  ('dominus', 1, 'Eerie Pumpkin Head', 36000000, 'common', 250, 1158416, 'pumpkin:#ff8a1f'),
  ('dominus', 2, 'Purple Sparkle Time Fedora', 36000000, 'uncommon', 200, 63043890, 'fedora:#7a3fd1:#2a1450:#e8d4ff'),
  ('dominus', 3, 'Domino Crown', 43200000, 'rare', 100, 1031429, 'crown:#1d1d22:#f5f5f5'),
  ('dominus', 4, 'Dominus Frigidus', 162000000, 'epic', 40, 48545806, 'hood:#a8dcff:#ffffff:#2a8cff'),
  ('dominus', 5, 'Dominus Empyreus', 198000000, 'legendary', 10, 21070012, 'hood:#f4f1ff:#ffd86b:#9be7ff');
-- Case price = average item value + 8%, rounded up to the next 100 coins.
update public.cases c set price = ceil(s.ev * 1.08 / 100) * 100
  from (select case_id, sum(value * weight)::numeric / sum(weight) as ev from public.case_items group by case_id) s
 where s.case_id = c.id;

-- ---------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[]), public.battle_join(uuid, int), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text)
  to authenticated;

-- Live updates for battles and chat
alter publication supabase_realtime add table public.battles, public.chat_messages;

-- =====================================================================
-- Included: update 2 (levels, profiles, transactions, tips)
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
-- Included: update 3 (Upgrader + 5% house edge)
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
-- Included: update 4 (Rewards: daily level packs)
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
-- Included: update 5 (Blackjack)
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
-- Included: update 6 (Weekly leaderboard)
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
-- Included: update 7 (30 cases + gold dice top pulls)
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

-- =====================================================================
-- Included: update 8 (balance, battle modes, admin)
-- =====================================================================

insert into public.upgrade_items (id, name, robux, value) values
  (1028606, 'Red Baseball Cap', 1389, 2500),
  (1272713, 'Christmas Baseball Cap', 1111, 2000),
  (1309918, 'Blue Winter Cap', 1944, 3500),
  (1530795, 'Stationary Egg of Boring', 667, 1200),
  (1532381, 'Blinking Egg of Relocation', 1000, 1800),
  (1532384, 'Bouncing Egg of Boing Boing', 1222, 2200),
  (1532386, 'Puzzling Egg of Enigma', 1444, 2600),
  (1532395, 'Kind Egg of Sharing', 1167, 2100),
  (1051578, 'Target Hat', 1500, 2700),
  (5785985, 'Rusty Tetramino of Competence', 1944, 3500),
  (5786026, 'Silver Tetramino of Accomplishment', 1333, 2400),
  (5786047, 'Gold Tetramino of Mastery', 1500, 2700),
  (6379764, 'Racing Helmet', 500, 900),
  (6512277, 'Tixsplosion', 1389, 2500),
  (7319168, 'The Moon', 1611, 2900),
  (10860580, 'The Viridium Skull', 1611, 2900),
  (11188705, 'Take a Chance', 1500, 2700),
  (11297746, 'White Ninja Headband of the Unimpeachable Soul', 1556, 2800),
  (11721340, '2009 Graduation Cap', 1278, 2300),
  (11844853, 'Turbo Builders Club Hard Hat', 722, 1300),
  (12503326, 'Canadian Baseball Cap', 1278, 2300),
  (13121630, 'Red Wizard Hat of Flames', 1667, 3000),
  (13334984, 'Summertime 2009 R&R&R', 1778, 3200),
  (15727771, 'Halloween Harbinger', 1833, 3300),
  (15857936, 'Tee Vee', 1944, 3500),
  (16412796, 'Sk9r Boi', 1500, 2700),
  (16985920, 'Pink Penguin', 778, 1400),
  (16986805, 'Pumpkin Pi', 1389, 2500),
  (17394804, 'Red Monster League Baseball Cap', 1944, 3500),
  (17408283, 'Outrageous Builders Club Hard Hat', 889, 1600),
  (17449403, 'Guardia Helm', 1722, 3100),
  (17450058, 'Ruby Serpent Mummy Mask', 1167, 2100),
  (17735309, 'Sand Tempest Nomad', 1278, 2300),
  (17925914, 'Commando Skullcap', 1333, 2400),
  (18171366, 'Arctic Hood', 556, 1000),
  (18174901, 'Guardia in Exile', 444, 800),
  (18426536, 'Apple Pie', 1444, 2600),
  (18448414, 'Gobble Gobble', 1222, 2200),
  (18803866, 'Sports Elf', 1389, 2500),
  (19395368, 'Your Head, a Marshmallow Floating in Hot Chocolate', 1444, 2600),
  (19644587, 'Subzero Ski Specs', 1556, 2800),
  (20064349, '2010 Fireworks', 722, 1300),
  (20573078, 'Shaggy', 1278, 2300),
  (20945159, 'Chill Classic', 1556, 2800),
  (22070807, 'Fuchsia Kitty Ears', 1111, 2000),
  (22151762, 'Heart Hat', 722, 1300),
  (23999354, 'Lucky Clover Cap', 1111, 2000),
  (24826625, 'Duskeye Egg of the Crossroads', 1222, 2200),
  (24826640, 'Chrome Egg of Speeding Bullet', 278, 500),
  (24826656, 'Egg of Equinox: Day', 278, 500),
  (24826683, 'Egg of Equinox: Night', 444, 800),
  (24826693, 'Shiny Gold Egg of Switcheroo', 278, 500),
  (24826704, 'Radioactive Egg of Undead Apocalypse', 667, 1200),
  (24826725, 'Scenic Egg of the Clouds', 667, 1200),
  (24826737, 'POW! To the Moon! Egg', 222, 400),
  (24826755, 'Explosive Egg of Kaboom!', 444, 800),
  (24826771, 'Violently Pink Egg of Violent Opinions', 1444, 2600),
  (24826787, 'Rusty Egg of Magnetism', 333, 600),
  (24826800, 'Specular Egg of Red, No Blue', 222, 400),
  (24826811, 'Agonizingly Ugly Egg of Screensplat', 222, 400),
  (24826840, 'Unassuming Egg of Shyness', 222, 400),
  (24826853, 'Vicious Egg of Singularity', 889, 1600),
  (24830979, 'Blue Fabergé Egg', 667, 1200),
  (24832618, 'Red Fabergé Egg', 1278, 2300),
  (24832637, 'Green Fabergé Egg', 1833, 3300),
  (25535420, 'Blue Swashbuckler', 1222, 2200),
  (25977727, 'Earth Day 2010 Cap', 1333, 2400),
  (26943415, 'Mathzilla', 1333, 2400),
  (27345567, 'Fiery Egg of Egg Testing', 278, 500),
  (29715001, 'Gentleman Patriot', 1667, 3000),
  (29715020, 'American Baseball Cap', 1389, 2500),
  (31151864, 'Starry Egg of the Wild Ride', 833, 1500),
  (31156903, 'Extinct Egg of Dino On Ice', 667, 1200),
  (31157811, 'Zeno''s Egg of Paradox', 444, 800),
  (33097647, 'Korblox Ice Zombie', 1000, 1800),
  (33810096, 'Mildly Disturbing Mask', 556, 1000),
  (35246042, 'Double Rainbow', 944, 1700),
  (35686181, 'Frankencap', 1333, 2400),
  (42781787, 'Christmas Tree', 1333, 2400),
  (42781797, 'Candy Cane Cap', 500, 900),
  (42840130, 'Grotesque Pile of One Hundred Thousand Eyeballs', 1167, 2100),
  (42846005, 'Snowflake Winter Cap', 778, 1400),
  (44113968, 'Kuddle E. Koala', 556, 1000),
  (46138556, 'Valentine''s Day 2011 Cap', 1278, 2300),
  (50430337, 'Earth Day 2011 Tie', 944, 1700),
  (51243520, 'Homemade Robot', 833, 1500),
  (51245998, 'Zipper Cap', 222, 400),
  (55224802, 'AmeriPhones', 1167, 2100),
  (61847146, 'Halloween 2011 Paintball Cap', 1167, 2100),
  (62720331, 'Harbinger of the Neverending Winter', 1111, 2000),
  (63647492, 'Fried Egg Eye Patch', 1722, 3100),
  (67200878, 'Snowflake Styles', 1333, 2400),
  (67250836, 'Santa Earmuffs', 1167, 2100),
  (67318983, 'Jolly Elf', 1222, 2200),
  (67995955, 'Spring into Christmas', 1000, 1800),
  (67996003, 'El Presidente', 1333, 2400),
  (67996263, 'Deluxe Ninja Swordpack', 1722, 3100),
  (69344141, 'Noob Assist: Donut Dash', 944, 1700),
  (71484026, 'Sinister Branches', 1944, 3500),
  (73799348, 'The Axe of Undoing: A Walmart Exclusive', 1500, 2700),
  (74174927, 'Panda Knit', 1667, 3000),
  (76692077, 'Futuristic Egg of Antigravity', 278, 500),
  (76692101, 'Charles Babbage Fabergé Egg', 500, 900),
  (76692143, 'Chaos Canyon Sugar Egg', 389, 700),
  (76692172, 'Crossroads Sugar Egg', 389, 700),
  (76692196, 'Insanely Valuable Crystal Egg', 278, 500),
  (76692214, 'Eggcognito Egg', 389, 700),
  (76692249, 'Eggsterminator Egg', 389, 700),
  (76692269, 'Egg Timer', 222, 400),
  (76692291, 'Egg of All-Devouring Darkness', 500, 900),
  (76692318, 'Azurewrath Fabergé Egg', 500, 900),
  (76692331, 'Ethereal Ghost Egg', 1111, 2000),
  (76692350, 'Self Replicating Egg of Grey Goo', 222, 400),
  (76692381, 'Hyperactive Egg of Hyperactivity', 222, 400),
  (76692407, 'The Last Egg of 2012', 333, 600),
  (76692437, 'Combo Egg of Trolllolol', 222, 400),
  (76692515, 'Molten Meteoric Core Egg', 222, 400),
  (76692532, 'Office Professional Egg', 222, 400),
  (76692582, 'Ruby Filigree Fabergé Egg', 389, 700),
  (76692611, 'Sword Fight on the Heights Sugar Egg', 556, 1000)
on conflict (id) do nothing;

update public.cases c set price = v.price from (values
  ('blue-grin', 5200),
  ('ember', 6800),
  ('topaz', 12000),
  ('gilded-night', 15000),
  ('bubblegum-grin', 16000),
  ('pop-art', 18000),
  ('golden-snow', 21000),
  ('midnight-holly', 30000),
  ('smiley', 45000),
  ('frostbite', 50000),
  ('tropical-pop', 68000),
  ('retro-wave', 75000),
  ('sunbeam', 150000),
  ('arctic-moss', 180000),
  ('shadow-beats', 240000),
  ('neon-pop', 310000),
  ('mistletoe', 380000),
  ('lime-grin', 400000),
  ('winter-crown', 550000),
  ('violet-beats', 700000),
  ('crystal-beats', 700000),
  ('glacier', 1000000),
  ('evergreen', 1000000),
  ('fire-ice', 1100000),
  ('black-ice', 2000000),
  ('jade', 5000000),
  ('sapphire', 6000000),
  ('amethyst', 10000000),
  ('sunset-remix', 12000000),
  ('ultimate-grin', 55000000)
) v(id, price) where c.id = v.id;

delete from public.case_items where case_id in ('blue-grin','ember','topaz','gilded-night','bubblegum-grin','pop-art','golden-snow','midnight-holly','smiley','frostbite','tropical-pop','retro-wave','sunbeam','arctic-moss','shadow-beats','neon-pop','mistletoe','lime-grin','winter-crown','violet-beats','crystal-beats','glacier','evergreen','fire-ice','black-ice','jade','sapphire','amethyst','sunset-remix','ultimate-grin');

insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('blue-grin', 0, 'Specular Egg of Red, No Blue', 400, 'common', 2354, 24826800, 'bighead:#9aa3b8', false),
  ('blue-grin', 1, 'Shiny Gold Egg of Switcheroo', 500, 'common', 4018, 24826693, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Blue Fabergé Egg', 1200, 'common', 32725, 24830979, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'Starry Egg of the Wild Ride', 1500, 'common', 55854, 31151864, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Blue Swashbuckler', 2200, 'uncommon', 139811, 25535420, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Blue Winter Cap', 3500, 'uncommon', 425239, 1309918, 'bighead:#9aa3b8', false),
  ('blue-grin', 6, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'rare', 48693, 1483632, 'bighead:#9aa3b8', false),
  ('blue-grin', 7, 'White Witch Hat', 7300, 'epic', 90563, 5207053, 'bighead:#9aa3b8', false),
  ('blue-grin', 8, 'Cyborg Soldier', 9400, 'epic', 170744, 27052155, 'bighead:#9aa3b8', false),
  ('blue-grin', 9, 'Jack Frost', 13700, 'legendary', 17315, 43245104, 'bighead:#9aa3b8', true),
  ('blue-grin', 10, 'Seeing Stars', 18700, 'legendary', 12685, 27599954, 'bighead:#9aa3b8', true),
  ('ember', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 4691, 24826640, 'bighead:#9aa3b8', false),
  ('ember', 1, 'Guardia in Exile', 800, 'common', 11562, 18174901, 'bighead:#9aa3b8', false),
  ('ember', 2, '2010 Fireworks', 1300, 'common', 29357, 20064349, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Christmas Baseball Cap', 2000, 'common', 67107, 1272713, 'bighead:#9aa3b8', false),
  ('ember', 4, 'Summertime 2009 R&R&R', 3200, 'uncommon', 165392, 13334984, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Black Lightning', 4600, 'uncommon', 331889, 29532225, 'bighead:#9aa3b8', false),
  ('ember', 6, 'Sir Burnsalot', 8500, 'rare', 112683, 16158562, 'bighead:#9aa3b8', false),
  ('ember', 7, 'Black Iron Warhelm of Pwnage', 10200, 'epic', 123078, 10351018, 'bighead:#9aa3b8', false),
  ('ember', 8, 'Heat Vision Goggles', 10400, 'epic', 124240, 10748238, 'bighead:#9aa3b8', false),
  ('ember', 9, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 15472, 1285300, 'bighead:#9aa3b8', true),
  ('ember', 10, 'Burning Otaku, the Firesouled', 24600, 'legendary', 14528, 20980122, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'Charles Babbage Fabergé Egg', 900, 'common', 18148, 76692101, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Starry Egg of the Wild Ride', 1500, 'common', 33870, 31151864, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'Red Fabergé Egg', 2300, 'common', 57092, 24832618, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'Green Fabergé Egg', 3300, 'common', 88734, 24832637, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'Gold Buckle Capotain', 6200, 'uncommon', 191705, 5671970, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Robosquid', 9200, 'uncommon', 310452, 37238566, 'bighead:#9aa3b8', false),
  ('topaz', 6, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 85309, 14817131, 'bighead:#9aa3b8', false),
  ('topaz', 7, 'Failed Proofs of the Riemann Hypothesis', 23100, 'epic', 91924, 1285300, 'bighead:#9aa3b8', false),
  ('topaz', 8, 'Burning Otaku, the Firesouled', 24600, 'epic', 92767, 20980122, 'bighead:#9aa3b8', false),
  ('topaz', 9, 'Imagine', 41400, 'legendary', 15474, 30394316, 'bighead:#9aa3b8', true),
  ('topaz', 10, 'The Crown of Nachos', 44100, 'legendary', 14526, 22547617, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, 'Stationary Egg of Boring', 1200, 'common', 20273, 1530795, 'bighead:#9aa3b8', false),
  ('gilded-night', 1, 'Double Rainbow', 1700, 'common', 31564, 35246042, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Gold Tetramino of Mastery', 2700, 'common', 56830, 5786047, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'Golden Egg of Kings', 4200, 'common', 99652, 1532387, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'Black Paintball Mask', 6800, 'uncommon', 183855, 9254521, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 307826, 10351018, 'bighead:#9aa3b8', false),
  ('gilded-night', 6, 'Bucket', 18000, 'rare', 36172, 1081239, 'bighead:#9aa3b8', false),
  ('gilded-night', 7, 'Failed Proofs of the Riemann Hypothesis', 23100, 'epic', 55353, 1285300, 'bighead:#9aa3b8', false),
  ('gilded-night', 8, 'Burning Otaku, the Firesouled', 24600, 'epic', 61622, 20980122, 'bighead:#9aa3b8', false),
  ('gilded-night', 9, 'Hotdog Head', 35800, 'epic', 116854, 15318156, 'bighead:#9aa3b8', false),
  ('gilded-night', 10, 'Golden Headphones', 52700, 'legendary', 30000, 29051524, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, 'Pink Penguin', 1400, 'common', 111071, 16985920, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 1, 'Christmas Baseball Cap', 2000, 'common', 110051, 1272713, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'Violently Pink Egg of Violent Opinions', 2600, 'common', 109307, 24826771, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'I Heart Mom Sign', 4100, 'common', 108028, 10630526, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'White Witch Hat', 7300, 'uncommon', 106428, 5207053, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Bag O'' Noobs', 11800, 'uncommon', 105115, 32355759, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 6, 'Seeing Stars', 18700, 'rare', 22997, 27599954, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 7, 'Burning Otaku, the Firesouled', 24600, 'epic', 61425, 20980122, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 8, 'Hotdog Head', 35800, 'epic', 235578, 15318156, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 9, 'Pin Head', 56100, 'legendary', 15198, 25880554, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 10, 'Bubble Trouble', 57600, 'legendary', 14802, 19264845, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Double Rainbow', 1700, 'common', 115301, 35246042, 'bighead:#9aa3b8', false),
  ('pop-art', 1, 'Bouncing Egg of Boing Boing', 2200, 'common', 113307, 1532384, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'Blue Winter Cap', 3500, 'common', 109803, 1309918, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Bloxxadore Domino Mask', 5200, 'common', 106900, 14492461, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Traffic Cone', 7200, 'uncommon', 104572, 1082932, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Jack Frost', 13700, 'uncommon', 100117, 43245104, 'bighead:#9aa3b8', false),
  ('pop-art', 6, 'Mick McCann', 21100, 'rare', 45115, 23264604, 'bighead:#9aa3b8', false),
  ('pop-art', 7, 'Hotdog Head', 35800, 'epic', 119197, 15318156, 'bighead:#9aa3b8', false),
  ('pop-art', 8, 'Imagine', 41400, 'epic', 155689, 30394316, 'bighead:#9aa3b8', false),
  ('pop-art', 9, 'The Bluesteel Bathelm', 63000, 'legendary', 15280, 1172161, 'bighead:#9aa3b8', true),
  ('pop-art', 10, 'Wildcard', 65400, 'legendary', 14720, 38322996, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Snowflake Winter Cap', 1400, 'common', 105284, 42846005, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Snowflake Styles', 2400, 'common', 104423, 67200878, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Golden Egg of Kings', 4200, 'common', 103536, 1532387, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Gold Buckle Capotain', 6200, 'common', 102924, 5671970, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 102146, 10351018, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Jack Frost', 13700, 'uncommon', 101688, 43245104, 'bighead:#9aa3b8', false),
  ('golden-snow', 6, 'Burning Otaku, the Firesouled', 24600, 'rare', 49335, 20980122, 'bighead:#9aa3b8', false),
  ('golden-snow', 7, 'Viridian Hood', 41200, 'epic', 140007, 16954107, 'bighead:#9aa3b8', false),
  ('golden-snow', 8, 'The Crown of Nachos', 44100, 'epic', 160658, 22547617, 'bighead:#9aa3b8', false),
  ('golden-snow', 9, 'Sword of the Winter Winds', 57600, 'legendary', 17162, 42847923, 'bighead:#9aa3b8', true),
  ('golden-snow', 10, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12838, 47597760, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, 'Santa Earmuffs', 2100, 'common', 109611, 67250836, 'bighead:#9aa3b8', false),
  ('midnight-holly', 1, 'Reading Textbook', 3900, 'common', 106307, 1136590, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Santa Hat', 5800, 'common', 104242, 1098277, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Chemistry Textbook', 8700, 'common', 102174, 1139753, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 99870, 14817131, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Mick McCann', 21100, 'uncommon', 97796, 23264604, 'bighead:#9aa3b8', false),
  ('midnight-holly', 6, 'Hotdog Head', 35800, 'rare', 48565, 15318156, 'bighead:#9aa3b8', false),
  ('midnight-holly', 7, 'Golden Headphones', 52700, 'epic', 115096, 29051524, 'bighead:#9aa3b8', false),
  ('midnight-holly', 8, 'Wildcard', 65400, 'epic', 186340, 38322996, 'bighead:#9aa3b8', false),
  ('midnight-holly', 9, 'Playful Vampire', 90000, 'legendary', 16274, 2409285794, 'bighead:#9aa3b8', true),
  ('midnight-holly', 10, 'Even Eviler Jester', 106700, 'legendary', 13726, 40893465, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Halloween Harbinger', 3300, 'common', 109104, 15727771, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'Treehugger Visor', 5700, 'common', 108745, 9910514, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'Labor Day 2009 Gear Goggles', 8800, 'common', 108460, 15595872, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Camoface', 12000, 'common', 108257, 24441888, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'Mick McCann', 21100, 'uncommon', 107889, 23264604, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Hotdog Head', 35800, 'uncommon', 107545, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 6, 'Golden Headphones', 52700, 'rare', 35238, 29051524, 'bighead:#9aa3b8', false),
  ('smiley', 7, 'Golden Chakram of the Sky Palace', 77000, 'epic', 93380, 47597760, 'bighead:#9aa3b8', false),
  ('smiley', 8, 'Lava Reactor', 101800, 'epic', 191382, 32858948, 'bighead:#9aa3b8', false),
  ('smiley', 9, 'Super Super Happy Face', 162000, 'legendary', 30000, 494291269, 'bighead:#9aa3b8', true),
  ('frostbite', 0, 'Blue Winter Cap', 3500, 'common', 1087, 1309918, 'bighead:#9aa3b8', false),
  ('frostbite', 1, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 3913, 1483632, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Cyborg Soldier', 9400, 'common', 14551, 27052155, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Jack Frost', 13700, 'common', 39120, 43245104, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Failed Proofs of the Riemann Hypothesis', 23100, 'uncommon', 154203, 1285300, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'Hotdog Head', 35800, 'uncommon', 487125, 15318156, 'bighead:#9aa3b8', false),
  ('frostbite', 6, 'Sword of the Winter Winds', 57600, 'rare', 57291, 42847923, 'bighead:#9aa3b8', false),
  ('frostbite', 7, 'The Bluesteel Bathelm', 63000, 'rare', 68918, 1172161, 'bighead:#9aa3b8', false),
  ('frostbite', 8, 'Playful Vampire', 90000, 'epic', 143791, 2409285794, 'bighead:#9aa3b8', false),
  ('frostbite', 9, 'Korblox King', 168200, 'legendary', 15508, 52492417, 'bighead:#9aa3b8', true),
  ('frostbite', 10, 'The Ice Skull of Nevermoor', 180000, 'legendary', 14492, 6552254, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Ladies Who Lunch', 5600, 'common', 1074, 35167841, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'White Witch Hat', 7300, 'common', 2212, 5207053, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Perfectly Legitimate Business Hat', 10800, 'common', 6428, 19027209, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Mick McCann', 21100, 'common', 39845, 23264604, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'Hotdog Head', 35800, 'uncommon', 168199, 15318156, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'Golden Headphones', 52700, 'uncommon', 482242, 29051524, 'bighead:#9aa3b8', false),
  ('tropical-pop', 6, 'Sundae Best', 74600, 'rare', 79856, 35685322, 'bighead:#9aa3b8', false),
  ('tropical-pop', 7, 'Lava Reactor', 101800, 'epic', 93907, 32858948, 'bighead:#9aa3b8', false),
  ('tropical-pop', 8, 'Even Eviler Jester', 106700, 'epic', 96237, 40893465, 'bighead:#9aa3b8', false),
  ('tropical-pop', 9, 'Picklace', 192600, 'legendary', 16736, 33615415, 'bighead:#9aa3b8', true),
  ('tropical-pop', 10, 'JJ5x5''s White Top Hat', 243000, 'legendary', 13264, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, 'Treehugger Visor', 5700, 'common', 119307, 9910514, 'bighead:#9aa3b8', false),
  ('retro-wave', 1, 'Labor Day 2009 Gear Goggles', 8800, 'common', 114832, 15595872, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Kid Robot', 12500, 'common', 111338, 29283299, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'Failed Proofs of the Riemann Hypothesis', 23100, 'common', 105480, 1285300, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'Hotdog Head', 35800, 'uncommon', 101489, 15318156, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Pin Head', 56100, 'uncommon', 97555, 25880554, 'bighead:#9aa3b8', false),
  ('retro-wave', 6, 'Playful Vampire', 90000, 'rare', 51998, 2409285794, 'bighead:#9aa3b8', false),
  ('retro-wave', 7, 'Super Super Happy Face', 162000, 'epic', 130077, 494291269, 'bighead:#9aa3b8', false),
  ('retro-wave', 8, 'Korblox King', 168200, 'epic', 137926, 52492417, 'bighead:#9aa3b8', false),
  ('retro-wave', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 15789, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 10, 'Monstars Visor', 270000, 'legendary', 14211, 1086815, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'Black Iron Warhelm of Pwnage', 10200, 'common', 3134, 10351018, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Bucket', 18000, 'common', 9986, 1081239, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'Burning Otaku, the Firesouled', 24600, 'common', 18887, 20980122, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Golden Headphones', 52700, 'uncommon', 89384, 29051524, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Sundae Best', 74600, 'uncommon', 181634, 35685322, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'Even Eviler Jester', 106700, 'uncommon', 376975, 40893465, 'bighead:#9aa3b8', false),
  ('sunbeam', 6, 'The Ice Skull of Nevermoor', 180000, 'rare', 94851, 6552254, 'bighead:#9aa3b8', false),
  ('sunbeam', 7, 'JJ5x5''s White Top Hat', 243000, 'epic', 97162, 1073690, 'bighead:#9aa3b8', false),
  ('sunbeam', 8, 'Monstars Visor', 270000, 'epic', 97987, 1086815, 'bighead:#9aa3b8', false),
  ('sunbeam', 9, 'Valkyrie Helm', 540000, 'legendary', 30000, 1365767, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'Jack Frost', 13700, 'common', 632, 43245104, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'Mick McCann', 21100, 'common', 2425, 23264604, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'Hotdog Head', 35800, 'common', 12570, 15318156, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Golden Headphones', 52700, 'common', 41876, 29051524, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Golden Chakram of the Sky Palace', 77000, 'uncommon', 136299, 47597760, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'Even Eviler Jester', 106700, 'uncommon', 376198, 40893465, 'bighead:#9aa3b8', false),
  ('arctic-moss', 6, 'The Ice Skull of Nevermoor', 180000, 'rare', 22050, 6552254, 'bighead:#9aa3b8', false),
  ('arctic-moss', 7, 'Picklace', 192600, 'rare', 32446, 33615415, 'bighead:#9aa3b8', false),
  ('arctic-moss', 8, 'JJ5x5''s White Top Hat', 243000, 'rare', 122310, 1073690, 'bighead:#9aa3b8', false),
  ('arctic-moss', 9, 'Monstars Visor', 270000, 'epic', 223195, 1086815, 'bighead:#9aa3b8', false),
  ('arctic-moss', 10, 'Valkyrie Helm', 540000, 'legendary', 16154, 1365767, 'bighead:#9aa3b8', true),
  ('arctic-moss', 11, 'Wanwood Antlers', 630000, 'legendary', 13846, 1272714, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, 'Bucket', 18000, 'common', 25146, 1081239, 'bighead:#9aa3b8', false),
  ('shadow-beats', 1, 'Burning Otaku, the Firesouled', 24600, 'common', 35719, 20980122, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'The Crown of Nachos', 44100, 'common', 68825, 22547617, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'Wildcard', 65400, 'common', 107161, 38322996, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Playful Vampire', 90000, 'uncommon', 153407, 2409285794, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Korblox King', 168200, 'uncommon', 309742, 52492417, 'bighead:#9aa3b8', false),
  ('shadow-beats', 6, 'Monstars Visor', 270000, 'rare', 69369, 1086815, 'bighead:#9aa3b8', false),
  ('shadow-beats', 7, 'Valkyrie Helm', 540000, 'epic', 200631, 1365767, 'bighead:#9aa3b8', false),
  ('shadow-beats', 8, 'Ice Valkyrie', 738000, 'legendary', 16023, 4390891467, 'bighead:#9aa3b8', true),
  ('shadow-beats', 9, 'Silver King of the Night', 846000, 'legendary', 13977, 439945661, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, 'Failed Proofs of the Riemann Hypothesis', 23100, 'common', 110610, 1285300, 'bighead:#9aa3b8', false),
  ('neon-pop', 1, 'Hotdog Head', 35800, 'common', 108445, 15318156, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Sword of the Winter Winds', 57600, 'common', 106143, 42847923, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'Playful Vampire', 90000, 'common', 104027, 2409285794, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'Super Super Happy Face', 162000, 'uncommon', 101305, 494291269, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'JJ5x5''s White Top Hat', 243000, 'uncommon', 99468, 1073690, 'bighead:#9aa3b8', false),
  ('neon-pop', 6, 'Valkyrie Helm', 540000, 'epic', 158548, 1365767, 'bighead:#9aa3b8', false),
  ('neon-pop', 7, 'Wanwood Antlers', 630000, 'epic', 181452, 1272714, 'bighead:#9aa3b8', false),
  ('neon-pop', 8, 'Pink Queen of the Night', 1026000, 'legendary', 15630, 553971558, 'bighead:#9aa3b8', true),
  ('neon-pop', 9, 'Neon Purple Crazy Crown', 1116000, 'legendary', 14370, 376805769, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'Burning Otaku, the Firesouled', 24600, 'common', 107011, 20980122, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'The Crown of Nachos', 44100, 'common', 104470, 22547617, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'Sundae Best', 74600, 'common', 102233, 35685322, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'Even Eviler Jester', 106700, 'common', 100737, 40893465, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'The Ice Skull of Nevermoor', 180000, 'uncommon', 98591, 6552254, 'bighead:#9aa3b8', false),
  ('mistletoe', 5, 'Monstars Visor', 270000, 'uncommon', 96959, 1086815, 'bighead:#9aa3b8', false),
  ('mistletoe', 6, 'Valkyrie Helm', 540000, 'epic', 109256, 1365767, 'bighead:#9aa3b8', false),
  ('mistletoe', 7, 'Ice Valkyrie', 738000, 'epic', 122285, 4390891467, 'bighead:#9aa3b8', false),
  ('mistletoe', 8, 'Silver King of the Night', 846000, 'epic', 128459, 439945661, 'bighead:#9aa3b8', false),
  ('mistletoe', 9, 'Green Ice Crown', 954000, 'legendary', 17578, 193696233, 'bighead:#9aa3b8', true),
  ('mistletoe', 10, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 12422, 149594212, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Hotdog Head', 35800, 'common', 112291, 15318156, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Golden Headphones', 52700, 'common', 110708, 29051524, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'Sundae Best', 74600, 'common', 109304, 35685322, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Even Eviler Jester', 106700, 'common', 107876, 40893465, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Picklace', 192600, 'uncommon', 105561, 33615415, 'bighead:#9aa3b8', false),
  ('lime-grin', 5, 'Monstars Visor', 270000, 'uncommon', 104260, 1086815, 'bighead:#9aa3b8', false),
  ('lime-grin', 6, 'Valkyrie Helm', 540000, 'rare', 77240, 1365767, 'bighead:#9aa3b8', false),
  ('lime-grin', 7, 'Brighteyes'' Bloxy Cola Hat', 900000, 'epic', 121380, 24114402, 'bighead:#9aa3b8', false),
  ('lime-grin', 8, 'Brighteyes'' Lavender Egg of Anticipation', 900000, 'epic', 121380, 24485062, 'bighead:#9aa3b8', false),
  ('lime-grin', 9, 'Crazy Glasses', 1350000, 'legendary', 15484, 16646369, 'bighead:#9aa3b8', true),
  ('lime-grin', 10, 'Clockwork''s Headphones', 1440000, 'legendary', 14516, 1235488, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, 'The Crown of Nachos', 44100, 'common', 27060, 22547617, 'bighead:#9aa3b8', false),
  ('winter-crown', 1, 'Wildcard', 65400, 'common', 46593, 38322996, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Lava Reactor', 101800, 'common', 85764, 32858948, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'Korblox King', 168200, 'common', 171402, 52492417, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Monstars Visor', 270000, 'uncommon', 329181, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Ice Valkyrie', 738000, 'rare', 52522, 4390891467, 'bighead:#9aa3b8', false),
  ('winter-crown', 6, 'Green Ice Crown', 954000, 'epic', 91290, 193696233, 'bighead:#9aa3b8', false),
  ('winter-crown', 7, 'The Fire Crown', 1260000, 'epic', 166187, 362032819, 'bighead:#9aa3b8', false),
  ('winter-crown', 8, 'Hooded Frostlord', 1800000, 'legendary', 15714, 136802867, 'bighead:#9aa3b8', true),
  ('winter-crown', 9, 'Red Crown of Ozymandias', 1980000, 'legendary', 14286, 9465511, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'Golden Headphones', 52700, 'common', 5441, 29051524, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'Golden Chakram of the Sky Palace', 77000, 'common', 11198, 47597760, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'Even Eviler Jester', 106700, 'common', 20836, 40893465, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Picklace', 192600, 'common', 64130, 33615415, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Monstars Visor', 270000, 'uncommon', 121990, 1086815, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'Valkyrie Helm', 540000, 'uncommon', 456406, 1365767, 'bighead:#9aa3b8', false),
  ('violet-beats', 6, 'Brighteyes'' Lavender Egg of Anticipation', 900000, 'rare', 88915, 24485062, 'bighead:#9aa3b8', false),
  ('violet-beats', 7, 'Pink Queen of the Night', 1026000, 'epic', 97553, 553971558, 'bighead:#9aa3b8', false),
  ('violet-beats', 8, 'Neon Purple Crazy Crown', 1116000, 'epic', 103532, 376805769, 'bighead:#9aa3b8', false),
  ('violet-beats', 9, 'Neon Green Crazy Crown', 2430000, 'legendary', 15273, 321346616, 'bighead:#9aa3b8', true),
  ('violet-beats', 10, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 14727, 188004500, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, 'Golden Headphones', 52700, 'common', 10863, 29051524, 'bighead:#9aa3b8', false),
  ('crystal-beats', 1, 'Golden Chakram of the Sky Palace', 77000, 'common', 19708, 47597760, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'Even Eviler Jester', 106700, 'common', 32901, 40893465, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'The Ice Skull of Nevermoor', 180000, 'common', 74814, 6552254, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'Monstars Visor', 270000, 'uncommon', 141454, 1086815, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'Valkyrie Helm', 540000, 'uncommon', 420260, 1365767, 'bighead:#9aa3b8', false),
  ('crystal-beats', 6, 'Ice Valkyrie', 738000, 'rare', 79793, 4390891467, 'bighead:#9aa3b8', false),
  ('crystal-beats', 7, 'Eyes of Emeraldwrath', 1260000, 'epic', 93253, 209994352, 'bighead:#9aa3b8', false),
  ('crystal-beats', 8, 'Clockwork''s Headphones', 1440000, 'epic', 96954, 1235488, 'bighead:#9aa3b8', false),
  ('crystal-beats', 9, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 17143, 188888052, 'bighead:#9aa3b8', true),
  ('crystal-beats', 10, 'Retro 80s Headphones', 2520000, 'legendary', 12857, 29844011, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'Sundae Best', 74600, 'common', 41254, 35685322, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'Even Eviler Jester', 106700, 'common', 50560, 40893465, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'The Ice Skull of Nevermoor', 180000, 'common', 68058, 6552254, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Monstars Visor', 270000, 'common', 85696, 1086815, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Valkyrie Helm', 540000, 'uncommon', 127073, 1365767, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'Ice Valkyrie', 738000, 'uncommon', 151759, 4390891467, 'bighead:#9aa3b8', false),
  ('glacier', 6, 'Green Ice Crown', 954000, 'rare', 175599, 193696233, 'bighead:#9aa3b8', false),
  ('glacier', 7, 'ColdLika: Snowman', 1440000, 'epic', 96203, 568921483, 'bighead:#9aa3b8', false),
  ('glacier', 8, 'Hooded Frostlord', 1800000, 'epic', 86899, 136802867, 'bighead:#9aa3b8', false),
  ('glacier', 9, 'Immortal Sword: Endless Ice Slasher', 1800000, 'epic', 86899, 568920951, 'bighead:#9aa3b8', false),
  ('glacier', 10, 'Chronomalum: The Wicked Helm', 3510000, 'legendary', 15190, 215719463, 'bighead:#9aa3b8', true),
  ('glacier', 11, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 14810, 74891470, 'bighead:#9aa3b8', true),
  ('evergreen', 0, 'Golden Chakram of the Sky Palace', 77000, 'common', 19434, 47597760, 'bighead:#9aa3b8', false),
  ('evergreen', 1, 'Even Eviler Jester', 106700, 'common', 28303, 40893465, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'Picklace', 192600, 'common', 55902, 33615415, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Monstars Visor', 270000, 'common', 82509, 1086815, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Valkyrie Helm', 540000, 'uncommon', 183411, 1365767, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Brighteyes'' Bloxy Cola Hat', 900000, 'rare', 330442, 24114402, 'bighead:#9aa3b8', false),
  ('evergreen', 6, 'Eyes of Emeraldwrath', 1260000, 'rare', 83344, 209994352, 'bighead:#9aa3b8', false),
  ('evergreen', 7, 'Helm of the Great Tree', 1350000, 'rare', 86056, 9910420, 'bighead:#9aa3b8', false),
  ('evergreen', 8, 'CW Ultimate: Sapphire Serenity', 1890000, 'epic', 100600, 188888052, 'bighead:#9aa3b8', false),
  ('evergreen', 9, 'Yellow Glowing Eyes', 3240000, 'legendary', 16154, 416846000, 'bighead:#9aa3b8', true),
  ('evergreen', 10, 'Green Glowing Eyes', 3780000, 'legendary', 13846, 398676450, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'Golden Chakram of the Sky Palace', 77000, 'common', 20551, 47597760, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'Even Eviler Jester', 106700, 'common', 30220, 40893465, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'The Ice Skull of Nevermoor', 180000, 'common', 56070, 6552254, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Monstars Visor', 270000, 'common', 90545, 1086815, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'Valkyrie Helm', 540000, 'uncommon', 205434, 1365767, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Ice Valkyrie', 738000, 'uncommon', 297181, 4390891467, 'bighead:#9aa3b8', false),
  ('fire-ice', 6, 'The Fire Crown', 1260000, 'rare', 54086, 362032819, 'bighead:#9aa3b8', false),
  ('fire-ice', 7, 'Red Crown of Ozymandias', 1980000, 'epic', 92581, 9465511, 'bighead:#9aa3b8', false),
  ('fire-ice', 8, 'Fire Ruby Crest', 2520000, 'epic', 123332, 17735316, 'bighead:#9aa3b8', false),
  ('fire-ice', 9, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 15714, 74891470, 'bighead:#9aa3b8', true),
  ('fire-ice', 10, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 14286, 215718515, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 142316, 6552254, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'JJ5x5''s White Top Hat', 243000, 'common', 138729, 1073690, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Ice Valkyrie', 738000, 'uncommon', 126220, 4390891467, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'Green Ice Crown', 954000, 'uncommon', 123493, 193696233, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'A Dark Presence', 1440000, 'uncommon', 119243, 20908915, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Mighty Mask of Zeus', 2340000, 'rare', 32842, 13793866, 'bighead:#9aa3b8', false),
  ('black-ice', 6, 'Azurewrath, Lord of the Void', 3420000, 'epic', 92298, 17109706, 'bighead:#9aa3b8', false),
  ('black-ice', 7, 'Sparkle Time Fedora', 4500000, 'epic', 194861, 1285307, 'bighead:#9aa3b8', false),
  ('black-ice', 8, 'The Void Star', 5580000, 'legendary', 16901, 1125510, 'bighead:#9aa3b8', true),
  ('black-ice', 9, 'The Ice Crown', 7200000, 'legendary', 13099, 1323384, 'bighead:#9aa3b8', true),
  ('jade', 0, 'Wanwood Antlers', 630000, 'common', 134572, 1272714, 'bighead:#9aa3b8', false),
  ('jade', 1, 'Green Ice Crown', 954000, 'common', 132334, 193696233, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Fancy St. Patrick''s Fedora', 1350000, 'common', 130491, 149594212, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Neon Green Crazy Crown', 2430000, 'uncommon', 127429, 321346616, 'bighead:#9aa3b8', false),
  ('jade', 4, 'Green Glowing Eyes', 3780000, 'uncommon', 125174, 398676450, 'bighead:#9aa3b8', false),
  ('jade', 5, 'The Void Star', 5580000, 'rare', 38301, 1125510, 'bighead:#9aa3b8', false),
  ('jade', 6, 'Telamon Hair', 9000000, 'epic', 112345, 31312357, 'bighead:#9aa3b8', false),
  ('jade', 7, 'Dominus Aureus', 10800000, 'epic', 169354, 138932314, 'bighead:#9aa3b8', false),
  ('jade', 8, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 15385, 215751161, 'bighead:#9aa3b8', true),
  ('jade', 9, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 14615, 147180077, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Valkyrie Helm', 540000, 'common', 107028, 1365767, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'Ice Valkyrie', 738000, 'common', 106917, 4390891467, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Admiral of the Royal Skyfleet', 1350000, 'common', 106704, 15731113, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'CW Ultimate: Sapphire Serenity', 1890000, 'common', 106586, 188888052, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Eyes of Azurewrath', 2520000, 'uncommon', 106484, 17999992, 'bighead:#9aa3b8', false),
  ('sapphire', 5, 'Sparkle Time Fedora', 4500000, 'uncommon', 106280, 1285307, 'bighead:#9aa3b8', false),
  ('sapphire', 6, 'The Ice Crown', 7200000, 'rare', 46656, 1323384, 'bighead:#9aa3b8', false),
  ('sapphire', 7, 'Dominus Aureus', 10800000, 'epic', 109135, 138932314, 'bighead:#9aa3b8', false),
  ('sapphire', 8, 'The Crown of Roses', 13500000, 'epic', 174209, 17449820, 'bighead:#9aa3b8', false),
  ('sapphire', 9, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 16000, 489196035, 'bighead:#9aa3b8', true),
  ('sapphire', 10, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 14000, 493476042, 'bighead:#9aa3b8', true),
  ('amethyst', 0, 'Glorious Purple Party Queen', 936000, 'common', 102844, 258184056, 'bighead:#9aa3b8', false),
  ('amethyst', 1, 'Neon Purple Crazy Crown', 1116000, 'common', 101705, 376805769, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'CW Ultimate: Sapphire Serenity', 1890000, 'common', 98370, 188888052, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'Crown of Om Nom Nom', 3060000, 'common', 95415, 21070350, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Sparkle Time Fedora', 4500000, 'uncommon', 93114, 1285307, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'Duchess of the Federation', 7740000, 'uncommon', 89972, 439984665, 'bighead:#9aa3b8', false),
  ('amethyst', 6, 'Lady of the Federation', 9900000, 'rare', 88581, 207207782, 'bighead:#9aa3b8', false),
  ('amethyst', 7, 'Orange Sparkle Time Fedora', 17100000, 'epic', 88930, 215751161, 'bighead:#9aa3b8', false),
  ('amethyst', 8, 'Teal Sparkle Time Fedora', 18000000, 'epic', 94393, 147180077, 'bighead:#9aa3b8', false),
  ('amethyst', 9, 'Sky Blue Sparkle Time Fedora', 21600000, 'epic', 116677, 493476042, 'bighead:#9aa3b8', false),
  ('amethyst', 10, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 30000, 63043890, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'Helm of the Sacred Earth', 900000, 'common', 676, 22157971, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Dominus Praefectus', 1422000, 'common', 2699, 527365852, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'Neon Green Crazy Crown', 2430000, 'common', 13656, 321346616, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Crown of Om Nom Nom', 3060000, 'common', 27430, 21070350, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'Sparkle Time Fedora', 4500000, 'uncommon', 88101, 1285307, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'Red Glowing Eyes', 8280000, 'uncommon', 557437, 180660043, 'bighead:#9aa3b8', false),
  ('sunset-remix', 6, 'The Crown of Roses', 13500000, 'rare', 76341, 17449820, 'bighead:#9aa3b8', false),
  ('sunset-remix', 7, 'Teal Sparkle Time Fedora', 18000000, 'epic', 94839, 147180077, 'bighead:#9aa3b8', false),
  ('sunset-remix', 8, 'Sky Blue Sparkle Time Fedora', 21600000, 'epic', 108820, 493476042, 'bighead:#9aa3b8', false),
  ('sunset-remix', 9, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 16364, 63043890, 'bighead:#9aa3b8', true),
  ('sunset-remix', 10, 'Domino Crown', 43200000, 'legendary', 13636, 1031429, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'Tixvalk', 4140000, 'common', 117396, 382881237, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'The Ice Crown', 7200000, 'common', 113662, 1323384, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, 'Lady of the Federation', 9900000, 'common', 111568, 207207782, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'Earl of the Federation', 16200000, 'common', 108405, 146134358, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Sky Blue Sparkle Time Fedora', 21600000, 'uncommon', 106599, 493476042, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Domino Crown', 43200000, 'uncommon', 102370, 1031429, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 6, 'Dominus Astra', 108000000, 'epic', 169222, 162067148, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 7, 'Dominus Infernus', 126000000, 'epic', 140778, 31101391, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 8, 'Dominus Frigidus', 162000000, 'legendary', 16500, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 9, 'Dominus Empyreus', 198000000, 'legendary', 13500, 21070012, 'bighead:#9aa3b8', true);

delete from public.reward_pack_items;
insert into public.reward_pack_items (level, idx, item_id, weight) values
  (10, 0, 24826737, 4000),
  (10, 1, 24826787, 3000),
  (10, 2, 18171366, 2000),
  (10, 3, 31151864, 920),
  (10, 4, 14817131, 60),
  (10, 5, 22547617, 20),
  (20, 0, 76692143, 4000),
  (20, 1, 1530795, 3000),
  (20, 2, 1532381, 2000),
  (20, 3, 13121630, 920),
  (20, 4, 16954107, 60),
  (20, 5, 40893465, 20),
  (30, 0, 31151864, 4000),
  (30, 1, 5786026, 3000),
  (30, 2, 52180878, 2000),
  (30, 3, 1098277, 920),
  (30, 4, 32858948, 60),
  (30, 5, 1086815, 20),
  (40, 0, 13121630, 4000),
  (40, 1, 1532389, 3000),
  (40, 2, 5207053, 2000),
  (40, 3, 24441888, 920),
  (40, 4, 1073690, 60),
  (40, 5, 1272714, 20),
  (50, 0, 5671970, 4000),
  (50, 1, 27052155, 3000),
  (50, 2, 14817131, 2000),
  (50, 3, 20980122, 920),
  (50, 4, 1365767, 60),
  (50, 5, 13370505, 20),
  (60, 0, 24441888, 4000),
  (60, 1, 27599954, 3000),
  (60, 2, 15318156, 2000),
  (60, 3, 22547617, 920),
  (60, 4, 417458345, 60),
  (60, 5, 21070350, 20),
  (70, 0, 15318156, 4000),
  (70, 1, 16954107, 3000),
  (70, 2, 1172161, 2000),
  (70, 3, 2409285794, 920),
  (70, 4, 9465511, 60),
  (70, 5, 14671091, 20),
  (80, 0, 29051524, 4000),
  (80, 1, 47597760, 3000),
  (80, 2, 40893465, 2000),
  (80, 3, 33615415, 920),
  (80, 4, 215718515, 60),
  (80, 5, 20573086, 20),
  (90, 0, 32858948, 4000),
  (90, 1, 494291269, 3000),
  (90, 2, 1073690, 2000),
  (90, 3, 1086815, 920),
  (90, 4, 144507154, 60),
  (90, 5, 23705521, 20),
  (100, 0, 1073690, 4000),
  (100, 1, 1086815, 3000),
  (100, 2, 1365767, 2000),
  (100, 3, 4390891467, 920),
  (100, 4, 9910070, 60),
  (100, 5, 259423244, 20);

-- Blackjack: classic payouts (wins 1 to 1, blackjack 3 to 2, insurance 2 to 1)
create or replace function public.bj_win_mult() returns numeric language sql immutable as $$ select 1.0 $$;

-- ---------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists is_admin boolean not null default false;
update public.profiles set is_admin = true where lower(username) = 'emperor';

alter table public.transactions drop constraint if exists transactions_game_check;
alter table public.transactions add constraint transactions_game_check
  check (game in ('cases','mines','battles','upgrader','blackjack','tips','rewards','admin'));

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.my_profile()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', id, 'username', username, 'coins', coins, 'faucet_at', faucet_at, 'admin', is_admin)
  from public.profiles where id = auth.uid()
$$;

create or replace function public.admin_stats()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (select json_build_object(
    'players', count(*),
    'new_today', count(*) filter (where created_at > now() - interval '24 hours'),
    'coins', coalesce(sum(coins), 0),
    'wagered', coalesce(sum(wagered), 0),
    'cases', coalesce(sum(cases_opened), 0),
    'online_chat', (select count(distinct user_id) from public.chat_messages where created_at > now() - interval '1 hour'))
  from public.profiles);
end $$;

create or replace function public.admin_find(p_q text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(json_agg(t order by t.wagered desc), '[]') from (
    select p.id, p.username, u.email, p.coins, p.wagered, p.created_at, p.is_admin
      from public.profiles p left join auth.users u on u.id = p.id
     where p_q is null or p_q = '' or p.username ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
     order by p.wagered desc limit 25) t);
end $$;

-- give (positive) or take (negative) coins; never goes below 0
create or replace function public.admin_coins(p_user uuid, p_amount bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_old bigint; v_new bigint;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_amount = 0 then raise exception 'Enter an amount'; end if;
  select coins into v_old from public.profiles where id = p_user for update;
  if v_old is null then raise exception 'Player not found'; end if;
  v_new := greatest(0, v_old + p_amount);
  update public.profiles set coins = v_new where id = p_user;
  perform public.tx(p_user, 'admin', case when p_amount > 0 then 'Added by admin' else 'Removed by admin' end, v_new - v_old);
  return v_new;
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_user = auth.uid() and not p_on then raise exception 'You can''t remove your own admin'; end if;
  update public.profiles set is_admin = p_on where id = p_user;
end $$;

create or replace function public.admin_delete_chat(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from public.chat_messages where id = p_id;
end $$;


-- ---------------------------------------------------------------------
-- Case battles: 3 way / 4 way, Group Unbox, Crazy, Jackpot, Borrow
--   Crazy   : lowest total wins
--   Jackpot : winner drawn at random, chance = share of everything pulled
--   Borrow  : that player pays 50% of the entry and receives 50% of winnings
--   Group   : everyone splits everything pulled
-- ---------------------------------------------------------------------
alter table public.battles drop constraint if exists battles_mode_check;
alter table public.battles add constraint battles_mode_check check (mode in ('1v1','3way','4way','2v2','3v3','2v2v2','g2','g3','g4'));
alter table public.battles drop constraint if exists battles_case_ids_check;
alter table public.battles add constraint battles_case_ids_check check (cardinality(case_ids) between 1 and 20);
alter table public.battles add column if not exists crazy   boolean not null default false;
alter table public.battles add column if not exists jackpot boolean not null default false;
alter table public.battles add column if not exists half    boolean[] not null default '{}';
alter table public.battles add column if not exists jp      jsonb;

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
create or replace function public.battle_fee(p_cost bigint, p_half boolean)
returns bigint language sql immutable as $$ select case when coalesce(p_half, false) then ceil(p_cost / 2.0)::bigint else p_cost end $$;

drop function if exists public.battle_create(text, text[]);
create or replace function public.battle_create(p_mode text, p_cases text[], p_crazy boolean default false, p_jackpot boolean default false, p_half boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cost bigint; v_fee bigint; v_found int; v_coins bigint; v_id uuid; n int; v_half boolean[];
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
  v_fee := public.battle_fee(v_cost, p_half);
  update public.profiles set coins = coins - v_fee, battles_played = battles_played + 1
   where id = v_uid and coins >= v_fee returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', v_fee);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || p_mode || case when p_half then ', borrow' else '' end || ')', -v_fee);
  n := public.battle_seats(p_mode);
  v_half := array_fill(false, array[n]); v_half[1] := coalesce(p_half, false);
  insert into public.battles (creator, mode, case_ids, cost, seats, crazy, jackpot, half)
  values (v_uid, p_mode, p_cases, v_cost, array[v_uid::text] || array_fill(null::text, array[n - 1]), p_crazy, p_jackpot, v_half)
  returning id into v_id;
  return json_build_object('id', v_id, 'coins', v_coins);
end $$;

drop function if exists public.battle_join(uuid, int);
create or replace function public.battle_join(p_id uuid, p_seat int, p_half boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b public.battles; v_coins bigint; v_fee bigint;
begin
  if v_uid is null then raise exception 'Sign in to play'; end if;
  select * into b from public.battles where id = p_id for update;
  if not found or b.status <> 'open' then raise exception 'This battle already started'; end if;
  if p_seat < 0 or p_seat >= cardinality(b.seats) then raise exception 'Bad seat'; end if;
  if b.seats[p_seat + 1] is not null then raise exception 'That seat was just taken'; end if;
  if v_uid::text = any (b.seats) then raise exception 'You are already in this battle'; end if;
  v_fee := public.battle_fee(b.cost, p_half);
  update public.profiles set coins = coins - v_fee, battles_played = battles_played + 1
   where id = v_uid and coins >= v_fee returning coins into v_coins;
  if not found then raise exception 'Not enough coins'; end if;
  perform public.add_wager(v_uid, 'battles', v_fee);
  perform public.tx(v_uid, 'battles', 'Battle entry (' || b.mode || case when p_half then ', borrow' else '' end || ')', -v_fee);
  b.seats[p_seat + 1] := v_uid::text;
  b.half[p_seat + 1] := coalesce(p_half, false);
  update public.battles set seats = b.seats, half = b.half where id = p_id;
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
      v_fee := public.battle_fee(b.cost, b.half[i]);
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
      v_amt := case when coalesce(b.half[s], false) then floor(v_share / 2) else v_share end;
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
  public.battle_create(text, text[], boolean, boolean, boolean), public.battle_join(uuid, int, boolean), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume(),
  public.admin_stats(), public.admin_find(text), public.admin_coins(uuid, bigint), public.admin_set_admin(uuid, boolean), public.admin_delete_chat(bigint)
  to authenticated;

-- =====================================================================
-- Included: update 9 (50 cases, risk styles, leaderboard hide)
-- =====================================================================

insert into public.cases (id, name, sort, price, image, active) values
  ('peppermint', 'Peppermint', 100, 600, 'assets/cases/peppermint.webp', true),
  ('crystal-egg', 'Crystal Egg', 101, 800, 'assets/cases/crystal-egg.webp', true),
  ('faberge', 'Fabergé', 102, 1000, 'assets/cases/faberge.webp', true),
  ('zombie-horde', 'Zombie Horde', 103, 1200, 'assets/cases/zombie-horde.webp', true),
  ('haunted-patch', 'Haunted Patch', 104, 1500, 'assets/cases/haunted-patch.webp', true),
  ('fiesta', 'Fiesta', 105, 2000, 'assets/cases/fiesta.webp', true),
  ('overgrown', 'Overgrown', 106, 2500, 'assets/cases/overgrown.webp', true),
  ('dragon-hatch', 'Dragon Hatch', 107, 3000, 'assets/cases/dragon-hatch.webp', true),
  ('orbit', 'Orbit', 108, 4000, 'assets/cases/orbit.webp', true),
  ('martian', 'Martian', 109, 5000, 'assets/cases/martian.webp', true),
  ('blue-grin', 'Blue Grin', 110, 5200, 'assets/cases/blue-grin.webp', true),
  ('gearhead', 'Gearhead', 111, 6500, 'assets/cases/gearhead.webp', true),
  ('gilded-night', 'Gilded Night', 112, 6600, 'assets/cases/gilded-night.webp', true),
  ('spooky-beats', 'Spooky Beats', 113, 8000, 'assets/cases/spooky-beats.webp', true),
  ('ember', 'Ember', 114, 9800, 'assets/cases/ember.webp', true),
  ('atlantis', 'Atlantis', 115, 10000, 'assets/cases/atlantis.webp', true),
  ('topaz', 'Topaz', 116, 12000, 'assets/cases/topaz.webp', true),
  ('tide-blade', 'Tide Blade', 117, 12000, 'assets/cases/tide-blade.webp', true),
  ('brass-samurai', 'Brass Samurai', 118, 15000, 'assets/cases/brass-samurai.webp', true),
  ('bubblegum-grin', 'Bubblegum Grin', 119, 16000, 'assets/cases/bubblegum-grin.webp', true),
  ('shogun', 'Shogun', 120, 20000, 'assets/cases/shogun.webp', true),
  ('golden-snow', 'Golden Snow', 121, 21000, 'assets/cases/golden-snow.webp', true),
  ('frostbite', 'Frostbite', 122, 22000, 'assets/cases/frostbite.webp', true),
  ('jurassic', 'Jurassic', 123, 25000, 'assets/cases/jurassic.webp', true),
  ('pop-art', 'Pop Art', 124, 26000, 'assets/cases/pop-art.webp', true),
  ('midnight-holly', 'Midnight Holly', 125, 30000, 'assets/cases/midnight-holly.webp', true),
  ('viking-ember', 'Viking Ember', 126, 35000, 'assets/cases/viking-ember.webp', true),
  ('nevermoor', 'Nevermoor', 127, 50000, 'assets/cases/nevermoor.webp', true),
  ('smiley', 'Smiley', 128, 65000, 'assets/cases/smiley.webp', true),
  ('tropical-pop', 'Tropical Pop', 129, 68000, 'assets/cases/tropical-pop.webp', true),
  ('retro-wave', 'Retro Wave', 130, 75000, 'assets/cases/retro-wave.webp', true),
  ('eclipse', 'Eclipse', 131, 75000, 'assets/cases/eclipse.webp', true),
  ('shadow-beats', 'Shadow Beats', 132, 110000, 'assets/cases/shadow-beats.webp', true),
  ('arctic-moss', 'Arctic Moss', 133, 180000, 'assets/cases/arctic-moss.webp', true),
  ('sunbeam', 'Sunbeam', 134, 220000, 'assets/cases/sunbeam.webp', true),
  ('neon-pop', 'Neon Pop', 135, 310000, 'assets/cases/neon-pop.webp', true),
  ('crystal-beats', 'Crystal Beats', 136, 320000, 'assets/cases/crystal-beats.webp', true),
  ('lime-grin', 'Lime Grin', 137, 400000, 'assets/cases/lime-grin.webp', true),
  ('mistletoe', 'Mistletoe', 138, 540000, 'assets/cases/mistletoe.webp', true),
  ('winter-crown', 'Winter Crown', 139, 550000, 'assets/cases/winter-crown.webp', true),
  ('violet-beats', 'Violet Beats', 140, 1000000, 'assets/cases/violet-beats.webp', true),
  ('glacier', 'Glacier', 141, 1000000, 'assets/cases/glacier.webp', true),
  ('evergreen', 'Evergreen', 142, 1000000, 'assets/cases/evergreen.webp', true),
  ('fire-ice', 'Fire Ice', 143, 1600000, 'assets/cases/fire-ice.webp', true),
  ('black-ice', 'Black Ice', 144, 2000000, 'assets/cases/black-ice.webp', true),
  ('amethyst', 'Amethyst', 145, 4500000, 'assets/cases/amethyst.webp', true),
  ('jade', 'Jade', 146, 5000000, 'assets/cases/jade.webp', true),
  ('sapphire', 'Sapphire', 147, 8600000, 'assets/cases/sapphire.webp', true),
  ('sunset-remix', 'Sunset Remix', 148, 12000000, 'assets/cases/sunset-remix.webp', true),
  ('ultimate-grin', 'Ultimate Grin', 149, 79000000, 'assets/cases/ultimate-grin.webp', true)
on conflict (id) do update set name = excluded.name, sort = excluded.sort, price = excluded.price, image = excluded.image, active = true;

delete from public.case_items where case_id in ('peppermint','crystal-egg','faberge','zombie-horde','haunted-patch','fiesta','overgrown','dragon-hatch','orbit','martian','blue-grin','gearhead','gilded-night','spooky-beats','ember','atlantis','topaz','tide-blade','brass-samurai','bubblegum-grin','shogun','golden-snow','frostbite','jurassic','pop-art','midnight-holly','viking-ember','nevermoor','smiley','tropical-pop','retro-wave','eclipse','shadow-beats','arctic-moss','sunbeam','neon-pop','crystal-beats','lime-grin','mistletoe','winter-crown','violet-beats','glacier','evergreen','fire-ice','black-ice','amethyst','jade','sapphire','sunset-remix','ultimate-grin');

insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('peppermint', 0, 'Zipper Cap', 400, 'uncommon', 489600, 51245998, 'bighead:#9aa3b8', false),
  ('peppermint', 1, 'Chrome Egg of Speeding Bullet', 500, 'rare', 115200, 24826640, 'bighead:#9aa3b8', false),
  ('peppermint', 2, 'Chrome Egg of Speeding Bullet', 500, 'rare', 115200, 24826640, 'bighead:#9aa3b8', false),
  ('peppermint', 3, 'Rusty Egg of Magnetism', 600, 'rare', 114012, 24826787, 'bighead:#9aa3b8', false),
  ('peppermint', 4, 'Chaos Canyon Sugar Egg', 700, 'rare', 58249, 76692143, 'bighead:#9aa3b8', false),
  ('peppermint', 5, 'Chaos Canyon Sugar Egg', 700, 'rare', 58249, 76692143, 'bighead:#9aa3b8', false),
  ('peppermint', 6, 'Candy Cane Cap', 900, 'epic', 19489, 42781797, 'bighead:#9aa3b8', false),
  ('peppermint', 7, 'Christmas Baseball Cap', 2000, 'legendary', 15366, 1272713, 'bighead:#9aa3b8', true),
  ('peppermint', 8, 'Halloween 2011 Paintball Cap', 2100, 'legendary', 14634, 61847146, 'bighead:#9aa3b8', true),
  ('crystal-egg', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 265134, 24826737, 'bighead:#9aa3b8', false),
  ('crystal-egg', 1, 'Chrome Egg of Speeding Bullet', 500, 'uncommon', 193899, 24826640, 'bighead:#9aa3b8', false),
  ('crystal-egg', 2, 'Chaos Canyon Sugar Egg', 700, 'rare', 120967, 76692143, 'bighead:#9aa3b8', false),
  ('crystal-egg', 3, 'Charles Babbage Fabergé Egg', 900, 'rare', 142625, 76692101, 'bighead:#9aa3b8', false),
  ('crystal-egg', 4, 'Charles Babbage Fabergé Egg', 900, 'rare', 142625, 76692101, 'bighead:#9aa3b8', false),
  ('crystal-egg', 5, 'Stationary Egg of Boring', 1200, 'epic', 114751, 1530795, 'bighead:#9aa3b8', false),
  ('crystal-egg', 6, 'Blinking Egg of Relocation', 1800, 'legendary', 10526, 1532381, 'bighead:#9aa3b8', true),
  ('crystal-egg', 7, 'Ethereal Ghost Egg', 2000, 'legendary', 9474, 76692331, 'bighead:#9aa3b8', true),
  ('faberge', 0, '30 Coins', 30, 'common', 380000, 0, 'coins', false),
  ('faberge', 1, 'POW! To the Moon! Egg', 400, 'uncommon', 160099, 24826737, 'bighead:#9aa3b8', false),
  ('faberge', 2, 'Chaos Canyon Sugar Egg', 700, 'uncommon', 151753, 76692143, 'bighead:#9aa3b8', false),
  ('faberge', 3, 'Charles Babbage Fabergé Egg', 900, 'rare', 148148, 76692101, 'bighead:#9aa3b8', false),
  ('faberge', 4, 'Stationary Egg of Boring', 1200, 'rare', 15788, 1530795, 'bighead:#9aa3b8', false),
  ('faberge', 5, 'Bouncing Egg of Boing Boing', 2200, 'epic', 37876, 1532384, 'bighead:#9aa3b8', false),
  ('faberge', 6, 'Golden Egg of Kings', 4200, 'epic', 96337, 1532387, 'bighead:#9aa3b8', false),
  ('faberge', 7, 'White Witch Hat', 7300, 'legendary', 5350, 5207053, 'bighead:#9aa3b8', true),
  ('faberge', 8, 'Das Deutschlandlied', 8400, 'legendary', 4650, 26018282, 'bighead:#9aa3b8', true),
  ('zombie-horde', 0, '40 Coins', 40, 'common', 380000, 0, 'coins', false),
  ('zombie-horde', 1, 'Chrome Egg of Speeding Bullet', 500, 'uncommon', 147200, 24826640, 'bighead:#9aa3b8', false),
  ('zombie-horde', 2, 'Mildly Disturbing Mask', 1000, 'rare', 156400, 33810096, 'bighead:#9aa3b8', false),
  ('zombie-horde', 3, 'Mildly Disturbing Mask', 1000, 'rare', 156400, 33810096, 'bighead:#9aa3b8', false),
  ('zombie-horde', 4, 'Radioactive Egg of Undead Apocalypse', 1200, 'rare', 7624, 24826704, 'bighead:#9aa3b8', false),
  ('zombie-horde', 5, 'Korblox Ice Zombie', 1800, 'epic', 17125, 33097647, 'bighead:#9aa3b8', false),
  ('zombie-horde', 6, 'Grotesque Pile of One Hundred Thousand Eyeballs', 2100, 'epic', 23294, 42840130, 'bighead:#9aa3b8', false),
  ('zombie-horde', 7, 'Gentlemen of Stratus', 4400, 'epic', 101957, 34111862, 'bighead:#9aa3b8', false),
  ('zombie-horde', 8, 'Halloween Santa Hat', 7100, 'legendary', 5697, 1173851, 'bighead:#9aa3b8', true),
  ('zombie-horde', 9, 'Cyborg Soldier', 9400, 'legendary', 4303, 27052155, 'bighead:#9aa3b8', true),
  ('haunted-patch', 0, 'POW! To the Moon! Egg', 400, 'common', 125990, 24826737, 'bighead:#9aa3b8', false),
  ('haunted-patch', 1, 'Rusty Egg of Magnetism', 600, 'uncommon', 207015, 24826787, 'bighead:#9aa3b8', false),
  ('haunted-patch', 2, 'Arctic Hood', 1000, 'uncommon', 386995, 18171366, 'bighead:#9aa3b8', false),
  ('haunted-patch', 3, 'Harbinger of the Neverending Winter', 2000, 'rare', 80981, 62720331, 'bighead:#9aa3b8', false),
  ('haunted-patch', 4, 'Halloween 2011 Paintball Cap', 2100, 'epic', 82219, 61847146, 'bighead:#9aa3b8', false),
  ('haunted-patch', 5, 'Pumpkin Pi', 2500, 'epic', 86801, 16986805, 'bighead:#9aa3b8', false),
  ('haunted-patch', 6, 'Bloxxadore Domino Mask', 5200, 'legendary', 15556, 14492461, 'bighead:#9aa3b8', true),
  ('haunted-patch', 7, 'Ladies Who Lunch', 5600, 'legendary', 14444, 35167841, 'bighead:#9aa3b8', true),
  ('fiesta', 0, 'Chaos Canyon Sugar Egg', 700, 'uncommon', 30994, 76692143, 'bighead:#9aa3b8', false),
  ('fiesta', 1, 'Racing Helmet', 900, 'uncommon', 56068, 6379764, 'bighead:#9aa3b8', false),
  ('fiesta', 2, 'Mildly Disturbing Mask', 1000, 'uncommon', 71886, 33810096, 'bighead:#9aa3b8', false),
  ('fiesta', 3, '2010 Fireworks', 1300, 'uncommon', 133475, 20064349, 'bighead:#9aa3b8', false),
  ('fiesta', 4, 'Blinking Egg of Relocation', 1800, 'rare', 287578, 1532381, 'bighead:#9aa3b8', false),
  ('fiesta', 5, 'Ruby Serpent Mummy Mask', 2100, 'rare', 130265, 17450058, 'bighead:#9aa3b8', false),
  ('fiesta', 6, 'El Presidente', 2400, 'rare', 133437, 67996003, 'bighead:#9aa3b8', false),
  ('fiesta', 7, 'Take a Chance', 2700, 'rare', 136298, 11188705, 'bighead:#9aa3b8', false),
  ('fiesta', 8, '27th Century Centurion', 5100, 'legendary', 10097, 21802112, 'bighead:#9aa3b8', true),
  ('fiesta', 9, 'Bloxxadore Domino Mask', 5200, 'legendary', 9903, 14492461, 'bighead:#9aa3b8', true),
  ('overgrown', 0, '80 Coins', 80, 'common', 330000, 0, 'coins', false),
  ('overgrown', 1, 'POW! To the Moon! Egg', 400, 'common', 26235, 24826737, 'bighead:#9aa3b8', false),
  ('overgrown', 2, 'Rusty Egg of Magnetism', 600, 'common', 41173, 24826787, 'bighead:#9aa3b8', false),
  ('overgrown', 3, 'Racing Helmet', 900, 'uncommon', 64615, 6379764, 'bighead:#9aa3b8', false),
  ('overgrown', 4, 'Earth Day 2011 Tie', 1700, 'uncommon', 131019, 50430337, 'bighead:#9aa3b8', false),
  ('overgrown', 5, 'Lucky Clover Cap', 2000, 'rare', 156958, 23999354, 'bighead:#9aa3b8', false),
  ('overgrown', 6, 'The Viridium Skull', 2900, 'rare', 30866, 10860580, 'bighead:#9aa3b8', false),
  ('overgrown', 7, 'Sinister Branches', 3500, 'epic', 45422, 71484026, 'bighead:#9aa3b8', false),
  ('overgrown', 8, 'Treehugger Visor', 5700, 'epic', 123713, 9910514, 'bighead:#9aa3b8', false),
  ('overgrown', 9, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 25243, 10351018, 'bighead:#9aa3b8', true),
  ('overgrown', 10, 'Mandrake Root', 10400, 'legendary', 24757, 1191812, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 7720, 24826640, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 1, 'Egg of Equinox: Night', 800, 'common', 33060, 24826683, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 2, 'Stationary Egg of Boring', 1200, 'uncommon', 115935, 1530795, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 3, 'Ethereal Ghost Egg', 2000, 'uncommon', 563285, 76692331, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 4, 'Fried Egg Eye Patch', 3100, 'rare', 36860, 63647492, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 5, 'Green Fabergé Egg', 3300, 'rare', 45336, 24832637, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 6, 'Invisible Egg of Shadow', 4900, 'epic', 167803, 1532389, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 7, 'Mandrake Root', 10400, 'legendary', 15283, 1191812, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 8, 'Perfectly Legitimate Business Hat', 10800, 'legendary', 14717, 19027209, 'bighead:#9aa3b8', true),
  ('orbit', 0, '120 Coins', 120, 'common', 380000, 0, 'coins', false),
  ('orbit', 1, 'Futuristic Egg of Antigravity', 500, 'common', 111540, 76692077, 'bighead:#9aa3b8', false),
  ('orbit', 2, 'Racing Helmet', 900, 'common', 113788, 6379764, 'bighead:#9aa3b8', false),
  ('orbit', 3, 'Earth Day 2011 Tie', 1700, 'uncommon', 116272, 50430337, 'bighead:#9aa3b8', false),
  ('orbit', 4, 'The Moon', 2900, 'uncommon', 118399, 7319168, 'bighead:#9aa3b8', false),
  ('orbit', 5, '27th Century Centurion', 5100, 'rare', 6113, 21802112, 'bighead:#9aa3b8', false),
  ('orbit', 6, 'Green Martian Space Helmet', 7200, 'epic', 13764, 12313606, 'bighead:#9aa3b8', false),
  ('orbit', 7, 'Seeing Stars', 18700, 'epic', 130124, 27599954, 'bighead:#9aa3b8', false),
  ('orbit', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 5927, 20980122, 'bighead:#9aa3b8', true),
  ('orbit', 9, 'Hotdog Head', 35800, 'legendary', 4073, 15318156, 'bighead:#9aa3b8', true),
  ('martian', 0, 'Double Rainbow', 1700, 'common', 32537, 35246042, 'bighead:#9aa3b8', false),
  ('martian', 1, 'Kind Egg of Sharing', 2100, 'uncommon', 52615, 1532395, 'bighead:#9aa3b8', false),
  ('martian', 2, 'Target Hat', 2700, 'uncommon', 93188, 1051578, 'bighead:#9aa3b8', false),
  ('martian', 3, 'Green Fabergé Egg', 3300, 'uncommon', 147090, 24832637, 'bighead:#9aa3b8', false),
  ('martian', 4, 'Golden Egg of Kings', 4200, 'rare', 254568, 1532387, 'bighead:#9aa3b8', false),
  ('martian', 5, 'Xenotargeting Oculus', 5100, 'rare', 94595, 14129301, 'bighead:#9aa3b8', false),
  ('martian', 6, 'Bloxxadore Domino Mask', 5200, 'rare', 95457, 14492461, 'bighead:#9aa3b8', false),
  ('martian', 7, 'Ladies Who Lunch', 5600, 'rare', 98819, 35167841, 'bighead:#9aa3b8', false),
  ('martian', 8, 'Green Martian Space Helmet', 7200, 'epic', 111129, 12313606, 'bighead:#9aa3b8', false),
  ('martian', 9, 'Cyborg Soldier', 9400, 'legendary', 10408, 27052155, 'bighead:#9aa3b8', true),
  ('martian', 10, 'Greenbot', 10200, 'legendary', 9592, 22023239, 'bighead:#9aa3b8', true),
  ('blue-grin', 0, '160 Coins', 160, 'common', 330000, 0, 'coins', false),
  ('blue-grin', 1, 'Guardia in Exile', 800, 'common', 183, 18174901, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Blue Fabergé Egg', 1200, 'common', 1418, 24830979, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'Korblox Ice Zombie', 1800, 'common', 11008, 33097647, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Blue Swashbuckler', 2200, 'uncommon', 30347, 25535420, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Blue Winter Cap', 3500, 'uncommon', 317044, 1309918, 'bighead:#9aa3b8', false),
  ('blue-grin', 6, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'rare', 5008, 1483632, 'bighead:#9aa3b8', false),
  ('blue-grin', 7, 'One Star General''s Beret', 6700, 'rare', 17429, 28039679, 'bighead:#9aa3b8', false),
  ('blue-grin', 8, 'Cyborg Soldier', 9400, 'epic', 237562, 27052155, 'bighead:#9aa3b8', false),
  ('blue-grin', 9, 'Jack Frost', 13700, 'legendary', 28858, 43245104, 'bighead:#9aa3b8', true),
  ('blue-grin', 10, 'Seeing Stars', 18700, 'legendary', 21142, 27599954, 'bighead:#9aa3b8', true),
  ('gearhead', 0, '200 Coins', 200, 'common', 330000, 0, 'coins', false),
  ('gearhead', 1, 'Arctic Hood', 1000, 'common', 178, 18171366, 'bighead:#9aa3b8', false),
  ('gearhead', 2, 'Homemade Robot', 1500, 'common', 1154, 51243520, 'bighead:#9aa3b8', false),
  ('gearhead', 3, 'AmeriPhones', 2100, 'common', 5447, 55224802, 'bighead:#9aa3b8', false),
  ('gearhead', 4, 'Rusty Tetramino of Competence', 3500, 'uncommon', 57421, 5785985, 'bighead:#9aa3b8', false),
  ('gearhead', 5, '27th Century Centurion', 5100, 'uncommon', 325800, 21802112, 'bighead:#9aa3b8', false),
  ('gearhead', 6, 'Labor Day 2009 Gear Goggles', 8800, 'rare', 7315, 15595872, 'bighead:#9aa3b8', false),
  ('gearhead', 7, 'McBrighteyes Shamrockin'' Headphones', 9400, 'epic', 13733, 48078122, 'bighead:#9aa3b8', false),
  ('gearhead', 8, 'Kid Robot', 12500, 'epic', 208952, 29283299, 'bighead:#9aa3b8', false),
  ('gearhead', 9, 'Mick McCann', 21100, 'legendary', 26131, 23264604, 'bighead:#9aa3b8', true),
  ('gearhead', 10, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 23869, 1285300, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, '200 Coins', 200, 'common', 350000, 0, 'coins', false),
  ('gilded-night', 1, 'Egg of Equinox: Night', 800, 'common', 22666, 24826683, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Starry Egg of the Wild Ride', 1500, 'common', 56002, 31151864, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'Gold Tetramino of Mastery', 2700, 'uncommon', 130474, 5786047, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'Black Lightning', 4600, 'uncommon', 280857, 29532225, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'McBrighteyes Shamrockin'' Headphones', 9400, 'epic', 6421, 48078122, 'bighead:#9aa3b8', false),
  ('gilded-night', 6, 'Outlawed Vampumatiger Hybrid', 13800, 'epic', 20845, 14817131, 'bighead:#9aa3b8', false),
  ('gilded-night', 7, 'Burning Otaku, the Firesouled', 24600, 'epic', 122734, 20980122, 'bighead:#9aa3b8', false),
  ('gilded-night', 8, 'Hotdog Head', 35800, 'legendary', 5955, 15318156, 'bighead:#9aa3b8', true),
  ('gilded-night', 9, 'Golden Headphones', 52700, 'legendary', 4045, 29051524, 'bighead:#9aa3b8', true),
  ('spooky-beats', 0, 'Explosive Egg of Kaboom!', 800, 'common', 16496, 24826755, 'bighead:#9aa3b8', false),
  ('spooky-beats', 1, 'Turbo Builders Club Hard Hat', 1300, 'common', 31627, 11844853, 'bighead:#9aa3b8', false),
  ('spooky-beats', 2, 'Harbinger of the Neverending Winter', 2000, 'common', 56345, 62720331, 'bighead:#9aa3b8', false),
  ('spooky-beats', 3, 'Halloween Harbinger', 3300, 'uncommon', 110260, 15727771, 'bighead:#9aa3b8', false),
  ('spooky-beats', 4, 'Invisible Egg of Shadow', 4900, 'uncommon', 187315, 1532389, 'bighead:#9aa3b8', false),
  ('spooky-beats', 5, 'Halloween Santa Hat', 7100, 'rare', 307958, 1173851, 'bighead:#9aa3b8', false),
  ('spooky-beats', 6, 'Chemistry Textbook', 8700, 'rare', 88429, 1139753, 'bighead:#9aa3b8', false),
  ('spooky-beats', 7, 'McBrighteyes Shamrockin'' Headphones', 9400, 'rare', 86686, 48078122, 'bighead:#9aa3b8', false),
  ('spooky-beats', 8, 'Boo Visor', 10200, 'rare', 84885, 16899436, 'bighead:#9aa3b8', false),
  ('spooky-beats', 9, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 15472, 1285300, 'bighead:#9aa3b8', true),
  ('spooky-beats', 10, 'Burning Otaku, the Firesouled', 24600, 'legendary', 14528, 20980122, 'bighead:#9aa3b8', true),
  ('ember', 0, 'Halloween Harbinger', 3300, 'common', 15538, 15727771, 'bighead:#9aa3b8', false),
  ('ember', 1, 'Black Lightning', 4600, 'uncommon', 44155, 29532225, 'bighead:#9aa3b8', false),
  ('ember', 2, 'Bloxxadore Domino Mask', 5200, 'uncommon', 64926, 14492461, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Black Paintball Mask', 6800, 'uncommon', 150930, 9254521, 'bighead:#9aa3b8', false),
  ('ember', 4, 'Sir Burnsalot', 8500, 'rare', 304451, 16158562, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Black Iron Warhelm of Pwnage', 10200, 'rare', 124677, 10351018, 'bighead:#9aa3b8', false),
  ('ember', 6, 'Heat Vision Goggles', 10400, 'rare', 126157, 10748238, 'bighead:#9aa3b8', false),
  ('ember', 7, 'Jack Frost', 13700, 'rare', 149166, 43245104, 'bighead:#9aa3b8', false),
  ('ember', 8, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 10314, 1285300, 'bighead:#9aa3b8', true),
  ('ember', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 9686, 20980122, 'bighead:#9aa3b8', true),
  ('atlantis', 0, 'Blue Winter Cap', 3500, 'uncommon', 13740, 1309918, 'bighead:#9aa3b8', false),
  ('atlantis', 1, 'Swashbuckler', 4100, 'uncommon', 24084, 46363750, 'bighead:#9aa3b8', false),
  ('atlantis', 2, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'uncommon', 77495, 1483632, 'bighead:#9aa3b8', false),
  ('atlantis', 3, 'Black Paintball Mask', 6800, 'uncommon', 144909, 9254521, 'bighead:#9aa3b8', false),
  ('atlantis', 4, 'Sir Burnsalot', 8500, 'rare', 319772, 16158562, 'bighead:#9aa3b8', false),
  ('atlantis', 5, 'Mandrake Root', 10400, 'rare', 118491, 1191812, 'bighead:#9aa3b8', false),
  ('atlantis', 6, 'Perfectly Legitimate Business Hat', 10800, 'rare', 123278, 19027209, 'bighead:#9aa3b8', false),
  ('atlantis', 7, 'Jack Frost', 13700, 'rare', 158230, 43245104, 'bighead:#9aa3b8', false),
  ('atlantis', 8, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 10314, 1285300, 'bighead:#9aa3b8', true),
  ('atlantis', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 9686, 20980122, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'Stationary Egg of Boring', 1200, 'common', 2416, 1530795, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Ethereal Ghost Egg', 2000, 'common', 10049, 76692331, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'Fried Egg Eye Patch', 3100, 'common', 34133, 63647492, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'Invisible Egg of Shadow', 4900, 'uncommon', 122453, 1532389, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'Das Deutschlandlied', 8400, 'uncommon', 550949, 26018282, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Kid Robot', 12500, 'rare', 66719, 29283299, 'bighead:#9aa3b8', false),
  ('topaz', 6, 'Jack Frost', 13700, 'rare', 72870, 43245104, 'bighead:#9aa3b8', false),
  ('topaz', 7, 'Mick McCann', 21100, 'epic', 110411, 23264604, 'bighead:#9aa3b8', false),
  ('topaz', 8, 'Imagine', 41400, 'legendary', 15474, 30394316, 'bighead:#9aa3b8', true),
  ('topaz', 9, 'The Crown of Nachos', 44100, 'legendary', 14526, 22547617, 'bighead:#9aa3b8', true),
  ('tide-blade', 0, '360 Coins', 360, 'common', 410000, 0, 'coins', false),
  ('tide-blade', 1, 'Outrageous Builders Club Hard Hat', 1600, 'common', 102819, 17408283, 'bighead:#9aa3b8', false),
  ('tide-blade', 2, 'White Ninja Headband of the Unimpeachable Soul', 2800, 'common', 105876, 11297746, 'bighead:#9aa3b8', false),
  ('tide-blade', 3, 'Invisible Egg of Shadow', 4900, 'uncommon', 109023, 1532389, 'bighead:#9aa3b8', false),
  ('tide-blade', 4, 'Sword of Nefertiti', 8600, 'uncommon', 112282, 21802000, 'bighead:#9aa3b8', false),
  ('tide-blade', 5, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 12147, 14817131, 'bighead:#9aa3b8', false),
  ('tide-blade', 6, 'Burning Otaku, the Firesouled', 24600, 'epic', 29447, 20980122, 'bighead:#9aa3b8', false),
  ('tide-blade', 7, 'Sword of the Winter Winds', 57600, 'epic', 108406, 42847923, 'bighead:#9aa3b8', false),
  ('tide-blade', 8, 'Playful Vampire', 90000, 'legendary', 5308, 2409285794, 'bighead:#9aa3b8', true),
  ('tide-blade', 9, 'Lava Reactor', 101800, 'legendary', 4692, 32858948, 'bighead:#9aa3b8', true),
  ('brass-samurai', 0, 'Starry Egg of the Wild Ride', 1500, 'common', 221, 31151864, 'bighead:#9aa3b8', false),
  ('brass-samurai', 1, 'Gold Tetramino of Mastery', 2700, 'common', 2528, 5786047, 'bighead:#9aa3b8', false),
  ('brass-samurai', 2, 'Golden Egg of Kings', 4200, 'common', 15764, 1532387, 'bighead:#9aa3b8', false),
  ('brass-samurai', 3, 'Gold Buckle Capotain', 6200, 'uncommon', 79133, 5671970, 'bighead:#9aa3b8', false),
  ('brass-samurai', 4, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 622354, 10351018, 'bighead:#9aa3b8', false),
  ('brass-samurai', 5, 'Bucket', 18000, 'rare', 75950, 1081239, 'bighead:#9aa3b8', false),
  ('brass-samurai', 6, 'Bucket', 18000, 'rare', 75950, 1081239, 'bighead:#9aa3b8', false),
  ('brass-samurai', 7, 'Burning Otaku, the Firesouled', 24600, 'epic', 98100, 20980122, 'bighead:#9aa3b8', false),
  ('brass-samurai', 8, 'The Crown of Nachos', 44100, 'legendary', 16333, 22547617, 'bighead:#9aa3b8', true),
  ('brass-samurai', 9, 'Golden Headphones', 52700, 'legendary', 13667, 29051524, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, '480 Coins', 480, 'common', 330000, 0, 'coins', false),
  ('bubblegum-grin', 1, 'Violently Pink Egg of Violent Opinions', 2600, 'common', 119, 24826771, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'I Heart Mom Sign', 4100, 'common', 1089, 10630526, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'Ladies Who Lunch', 5600, 'uncommon', 4971, 35167841, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'Das Deutschlandlied', 8400, 'uncommon', 35800, 26018282, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Kid Robot', 12500, 'uncommon', 248022, 29283299, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 6, 'Bucket', 18000, 'rare', 9753, 1081239, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 7, 'Seeing Stars', 18700, 'rare', 14853, 27599954, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 8, 'Burning Otaku, the Firesouled', 24600, 'epic', 305394, 20980122, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 9, 'Pin Head', 56100, 'legendary', 25330, 25880554, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 10, 'Bubble Trouble', 57600, 'legendary', 24670, 19264845, 'bighead:#9aa3b8', true),
  ('shogun', 0, '600 Coins', 600, 'common', 330000, 0, 'coins', false),
  ('shogun', 1, 'White Ninja Headband of the Unimpeachable Soul', 2800, 'common', 770, 11297746, 'bighead:#9aa3b8', false),
  ('shogun', 2, 'Gentlemen of Stratus', 4400, 'common', 3922, 34111862, 'bighead:#9aa3b8', false),
  ('shogun', 3, 'Green Martian Space Helmet', 7200, 'uncommon', 23127, 12313606, 'bighead:#9aa3b8', false),
  ('shogun', 4, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 81120, 10351018, 'bighead:#9aa3b8', false),
  ('shogun', 5, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 241062, 14817131, 'bighead:#9aa3b8', false),
  ('shogun', 6, 'Mick McCann', 21100, 'rare', 5426, 23264604, 'bighead:#9aa3b8', false),
  ('shogun', 7, 'Failed Proofs of the Riemann Hypothesis', 23100, 'rare', 10487, 1285300, 'bighead:#9aa3b8', false),
  ('shogun', 8, 'Hotdog Head', 35800, 'epic', 254086, 15318156, 'bighead:#9aa3b8', false),
  ('shogun', 9, 'Sword of the Winter Winds', 57600, 'legendary', 26119, 42847923, 'bighead:#9aa3b8', true),
  ('shogun', 10, 'The Bluesteel Bathelm', 63000, 'legendary', 23881, 1172161, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Santa Earmuffs', 2100, 'common', 2587, 67250836, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Blue Winter Cap', 3500, 'common', 11257, 1309918, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Santa Hat', 5800, 'common', 48171, 1098277, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Halloween Santa Hat', 7100, 'common', 86215, 1173851, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Jack Frost', 13700, 'uncommon', 571770, 43245104, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'rare', 76094, 1285300, 'bighead:#9aa3b8', false),
  ('golden-snow', 6, 'Burning Otaku, the Firesouled', 24600, 'rare', 78595, 20980122, 'bighead:#9aa3b8', false),
  ('golden-snow', 7, 'Hotdog Head', 35800, 'epic', 95311, 15318156, 'bighead:#9aa3b8', false),
  ('golden-snow', 8, 'Sword of the Winter Winds', 57600, 'legendary', 17162, 42847923, 'bighead:#9aa3b8', true),
  ('golden-snow', 9, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12838, 47597760, 'bighead:#9aa3b8', true),
  ('frostbite', 0, '660 Coins', 660, 'common', 320000, 0, 'coins', false),
  ('frostbite', 1, 'The Viridium Skull', 2900, 'common', 29170, 10860580, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 76901, 1483632, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Labor Day 2009 Gear Goggles', 8800, 'uncommon', 143379, 15595872, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Jack Frost', 13700, 'uncommon', 270550, 43245104, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'Burning Otaku, the Firesouled', 24600, 'rare', 2344, 20980122, 'bighead:#9aa3b8', false),
  ('frostbite', 6, 'Sword of the Winter Winds', 57600, 'epic', 30497, 42847923, 'bighead:#9aa3b8', false),
  ('frostbite', 7, 'Playful Vampire', 90000, 'epic', 117159, 2409285794, 'bighead:#9aa3b8', false),
  ('frostbite', 8, 'Korblox King', 168200, 'legendary', 5169, 52492417, 'bighead:#9aa3b8', true),
  ('frostbite', 9, 'The Ice Skull of Nevermoor', 180000, 'legendary', 4831, 6552254, 'bighead:#9aa3b8', true),
  ('jurassic', 0, 'Das Deutschlandlied', 8400, 'common', 417042, 26018282, 'bighead:#9aa3b8', false),
  ('jurassic', 1, 'Ochre Ogre', 10900, 'uncommon', 112434, 16723499, 'bighead:#9aa3b8', false),
  ('jurassic', 2, 'Jack Frost', 13700, 'uncommon', 35589, 43245104, 'bighead:#9aa3b8', false),
  ('jurassic', 3, 'Bucket', 18000, 'uncommon', 9012, 1081239, 'bighead:#9aa3b8', false),
  ('jurassic', 4, 'Mick McCann', 21100, 'rare', 4052, 23264604, 'bighead:#9aa3b8', false),
  ('jurassic', 5, 'Burning Otaku, the Firesouled', 24600, 'rare', 1872, 20980122, 'bighead:#9aa3b8', false),
  ('jurassic', 6, 'Hotdog Head', 35800, 'epic', 133379, 15318156, 'bighead:#9aa3b8', false),
  ('jurassic', 7, 'Viridian Hood', 41200, 'epic', 133312, 16954107, 'bighead:#9aa3b8', false),
  ('jurassic', 8, 'Imagine', 41400, 'epic', 133310, 30394316, 'bighead:#9aa3b8', false),
  ('jurassic', 9, 'Sword of the Winter Winds', 57600, 'legendary', 10448, 42847923, 'bighead:#9aa3b8', true),
  ('jurassic', 10, 'The Bluesteel Bathelm', 63000, 'legendary', 9552, 1172161, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Labor Day 2009 Gear Goggles', 8800, 'common', 316629, 15595872, 'bighead:#9aa3b8', false),
  ('pop-art', 1, 'Hollywood Sign', 11300, 'uncommon', 142110, 17614445, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 74907, 14817131, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Bucket', 18000, 'uncommon', 31976, 1081239, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Failed Proofs of the Riemann Hypothesis', 23100, 'rare', 14379, 1285300, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Hotdog Head', 35800, 'rare', 134027, 15318156, 'bighead:#9aa3b8', false),
  ('pop-art', 6, 'Viridian Hood', 41200, 'epic', 133004, 16954107, 'bighead:#9aa3b8', false),
  ('pop-art', 7, 'Imagine', 41400, 'epic', 132969, 30394316, 'bighead:#9aa3b8', false),
  ('pop-art', 8, 'The Bluesteel Bathelm', 63000, 'legendary', 10187, 1172161, 'bighead:#9aa3b8', true),
  ('pop-art', 9, 'Wildcard', 65400, 'legendary', 9813, 38322996, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, '900 Coins', 900, 'common', 330000, 0, 'coins', false),
  ('midnight-holly', 1, 'Sci-Fi Santa', 4500, 'common', 104, 18729820, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Halloween Santa Hat', 7100, 'common', 1002, 1173851, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Boo Visor', 10200, 'common', 6082, 16899436, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 27374, 14817131, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'uncommon', 355438, 1285300, 'bighead:#9aa3b8', false),
  ('midnight-holly', 6, 'Hotdog Head', 35800, 'rare', 8745, 15318156, 'bighead:#9aa3b8', false),
  ('midnight-holly', 7, 'Viridian Hood', 41200, 'rare', 26980, 16954107, 'bighead:#9aa3b8', false),
  ('midnight-holly', 8, 'Golden Headphones', 52700, 'epic', 194275, 29051524, 'bighead:#9aa3b8', false),
  ('midnight-holly', 9, 'Playful Vampire', 90000, 'legendary', 27123, 2409285794, 'bighead:#9aa3b8', true),
  ('midnight-holly', 10, 'Even Eviler Jester', 106700, 'legendary', 22877, 40893465, 'bighead:#9aa3b8', true),
  ('viking-ember', 0, 'Guardia Helm', 3100, 'common', 2303, 17449403, 'bighead:#9aa3b8', false),
  ('viking-ember', 1, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 11555, 1483632, 'bighead:#9aa3b8', false),
  ('viking-ember', 2, 'Sir Burnsalot', 8500, 'common', 33288, 16158562, 'bighead:#9aa3b8', false),
  ('viking-ember', 3, 'Jack Frost', 13700, 'uncommon', 117813, 43245104, 'bighead:#9aa3b8', false),
  ('viking-ember', 4, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 555041, 20980122, 'bighead:#9aa3b8', false),
  ('viking-ember', 5, 'Hotdog Head', 35800, 'rare', 64399, 15318156, 'bighead:#9aa3b8', false),
  ('viking-ember', 6, 'Viridian Hood', 41200, 'rare', 63120, 16954107, 'bighead:#9aa3b8', false),
  ('viking-ember', 7, 'Imagine', 41400, 'rare', 63076, 30394316, 'bighead:#9aa3b8', false),
  ('viking-ember', 8, 'The Bluesteel Bathelm', 63000, 'epic', 59405, 1172161, 'bighead:#9aa3b8', false),
  ('viking-ember', 9, 'Playful Vampire', 90000, 'legendary', 15923, 2409285794, 'bighead:#9aa3b8', true),
  ('viking-ember', 10, 'Lava Reactor', 101800, 'legendary', 14077, 32858948, 'bighead:#9aa3b8', true),
  ('nevermoor', 0, '27th Century Centurion', 5100, 'common', 1805, 21802112, 'bighead:#9aa3b8', false),
  ('nevermoor', 1, 'Das Deutschlandlied', 8400, 'common', 7842, 26018282, 'bighead:#9aa3b8', false),
  ('nevermoor', 2, 'Jack Frost', 13700, 'common', 33093, 43245104, 'bighead:#9aa3b8', false),
  ('nevermoor', 3, 'Mick McCann', 21100, 'uncommon', 117982, 23264604, 'bighead:#9aa3b8', false),
  ('nevermoor', 4, 'Hotdog Head', 35800, 'uncommon', 559277, 15318156, 'bighead:#9aa3b8', false),
  ('nevermoor', 5, 'Golden Headphones', 52700, 'rare', 80440, 29051524, 'bighead:#9aa3b8', false),
  ('nevermoor', 6, 'Pin Head', 56100, 'rare', 81315, 25880554, 'bighead:#9aa3b8', false),
  ('nevermoor', 7, 'Playful Vampire', 90000, 'epic', 88245, 2409285794, 'bighead:#9aa3b8', false),
  ('nevermoor', 8, 'Korblox King', 168200, 'legendary', 15508, 52492417, 'bighead:#9aa3b8', true),
  ('nevermoor', 9, 'The Ice Skull of Nevermoor', 180000, 'legendary', 14492, 6552254, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Mick McCann', 21100, 'common', 35527, 23264604, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'Hotdog Head', 35800, 'uncommon', 106892, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'The Crown of Nachos', 44100, 'uncommon', 165054, 22547617, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Pin Head', 56100, 'rare', 272527, 25880554, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'Sundae Best', 74600, 'rare', 141373, 35685322, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Golden Chakram of the Sky Palace', 77000, 'rare', 137696, 47597760, 'bighead:#9aa3b8', false),
  ('smiley', 6, 'Playful Vampire', 90000, 'rare', 120931, 2409285794, 'bighead:#9aa3b8', false),
  ('smiley', 7, 'Even Eviler Jester', 106700, 'legendary', 12058, 40893465, 'bighead:#9aa3b8', true),
  ('smiley', 8, 'Super Super Happy Face', 162000, 'legendary', 7942, 494291269, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Halloween Santa Hat', 7100, 'common', 227, 1173851, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'Perfectly Legitimate Business Hat', 10800, 'common', 1412, 19027209, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Bucket', 18000, 'common', 13113, 1081239, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 51238, 20980122, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'The Crown of Nachos', 44100, 'uncommon', 654010, 22547617, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'Sundae Best', 74600, 'rare', 34274, 35685322, 'bighead:#9aa3b8', false),
  ('tropical-pop', 6, 'Golden Chakram of the Sky Palace', 77000, 'rare', 39614, 47597760, 'bighead:#9aa3b8', false),
  ('tropical-pop', 7, 'Even Eviler Jester', 106700, 'epic', 176112, 40893465, 'bighead:#9aa3b8', false),
  ('tropical-pop', 8, 'Picklace', 192600, 'legendary', 16736, 33615415, 'bighead:#9aa3b8', true),
  ('tropical-pop', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 13264, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, '2,200 Coins', 2200, 'common', 330000, 0, 'coins', false),
  ('retro-wave', 1, 'Heat Vision Goggles', 10400, 'common', 140, 10748238, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Bucket', 18000, 'common', 1700, 1081239, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'Burning Otaku, the Firesouled', 24600, 'common', 7040, 20980122, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'Viridian Hood', 41200, 'uncommon', 73520, 16954107, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Sword of the Winter Winds', 57600, 'uncommon', 337599, 42847923, 'bighead:#9aa3b8', false),
  ('retro-wave', 6, 'Playful Vampire', 90000, 'rare', 5555, 2409285794, 'bighead:#9aa3b8', false),
  ('retro-wave', 7, 'Lava Reactor', 101800, 'rare', 11554, 32858948, 'bighead:#9aa3b8', false),
  ('retro-wave', 8, 'Super Super Happy Face', 162000, 'epic', 182892, 494291269, 'bighead:#9aa3b8', false),
  ('retro-wave', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 26316, 1073690, 'bighead:#9aa3b8', true),
  ('retro-wave', 10, 'Monstars Visor', 270000, 'legendary', 23684, 1086815, 'bighead:#9aa3b8', true),
  ('eclipse', 0, '2,200 Coins', 2200, 'common', 260000, 0, 'coins', false),
  ('eclipse', 1, 'Black Iron Warhelm of Pwnage', 10200, 'common', 25892, 10351018, 'bighead:#9aa3b8', false),
  ('eclipse', 2, 'Bucket', 18000, 'common', 61568, 1081239, 'bighead:#9aa3b8', false),
  ('eclipse', 3, 'Hotdog Head', 35800, 'uncommon', 175692, 15318156, 'bighead:#9aa3b8', false),
  ('eclipse', 4, 'Golden Headphones', 52700, 'uncommon', 316848, 29051524, 'bighead:#9aa3b8', false),
  ('eclipse', 5, 'Playful Vampire', 90000, 'rare', 4533, 2409285794, 'bighead:#9aa3b8', false),
  ('eclipse', 6, 'Korblox King', 168200, 'epic', 28795, 52492417, 'bighead:#9aa3b8', false),
  ('eclipse', 7, 'Monstars Visor', 270000, 'epic', 116671, 1086815, 'bighead:#9aa3b8', false),
  ('eclipse', 8, 'Valkyrie Helm', 540000, 'legendary', 5385, 1365767, 'bighead:#9aa3b8', true),
  ('eclipse', 9, 'Wanwood Antlers', 630000, 'legendary', 4615, 1272714, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, '3,300 Coins', 3300, 'common', 170000, 0, 'coins', false),
  ('shadow-beats', 1, 'Outlawed Vampumatiger Hybrid', 13800, 'common', 2328, 14817131, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'Burning Otaku, the Firesouled', 24600, 'common', 12780, 20980122, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'The Crown of Nachos', 44100, 'uncommon', 71347, 22547617, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Playful Vampire', 90000, 'rare', 583546, 2409285794, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Super Super Happy Face', 162000, 'epic', 47218, 494291269, 'bighead:#9aa3b8', false),
  ('shadow-beats', 6, 'Korblox King', 168200, 'epic', 47882, 52492417, 'bighead:#9aa3b8', false),
  ('shadow-beats', 7, 'JJ5x5''s White Top Hat', 243000, 'epic', 54901, 1073690, 'bighead:#9aa3b8', false),
  ('shadow-beats', 8, 'Ice Valkyrie', 738000, 'legendary', 5341, 4390891467, 'bighead:#9aa3b8', true),
  ('shadow-beats', 9, 'Silver King of the Night', 846000, 'legendary', 4659, 439945661, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'Bucket', 18000, 'common', 143, 1081239, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'Burning Otaku, the Firesouled', 24600, 'common', 618, 20980122, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'The Crown of Nachos', 44100, 'common', 9522, 22547617, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Sundae Best', 74600, 'uncommon', 111792, 35685322, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Even Eviler Jester', 106700, 'uncommon', 597925, 40893465, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'The Ice Skull of Nevermoor', 180000, 'rare', 11974, 6552254, 'bighead:#9aa3b8', false),
  ('arctic-moss', 6, 'Picklace', 192600, 'rare', 18139, 33615415, 'bighead:#9aa3b8', false),
  ('arctic-moss', 7, 'JJ5x5''s White Top Hat', 243000, 'rare', 75576, 1073690, 'bighead:#9aa3b8', false),
  ('arctic-moss', 8, 'Monstars Visor', 270000, 'epic', 144311, 1086815, 'bighead:#9aa3b8', false),
  ('arctic-moss', 9, 'Valkyrie Helm', 540000, 'legendary', 16154, 1365767, 'bighead:#9aa3b8', true),
  ('arctic-moss', 10, 'Wanwood Antlers', 630000, 'legendary', 13846, 1272714, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'Sundae Best', 74600, 'common', 59268, 35685322, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Playful Vampire', 90000, 'uncommon', 75053, 2409285794, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'Even Eviler Jester', 106700, 'uncommon', 92976, 40893465, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Super Super Happy Face', 162000, 'uncommon', 157232, 494291269, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Picklace', 192600, 'rare', 195471, 33615415, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'JJ5x5''s White Top Hat', 243000, 'rare', 185778, 1073690, 'bighead:#9aa3b8', false),
  ('sunbeam', 6, 'Monstars Visor', 270000, 'rare', 214222, 1086815, 'bighead:#9aa3b8', false),
  ('sunbeam', 7, 'Valkyrie Helm', 540000, 'legendary', 20000, 1365767, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, '9,300 Coins', 9300, 'common', 330000, 0, 'coins', false),
  ('neon-pop', 1, 'The Crown of Nachos', 44100, 'common', 13576, 22547617, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Wildcard', 65400, 'common', 25645, 38322996, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'Even Eviler Jester', 106700, 'common', 56515, 40893465, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'Super Super Happy Face', 162000, 'uncommon', 110891, 494291269, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'JJ5x5''s White Top Hat', 243000, 'uncommon', 213373, 1073690, 'bighead:#9aa3b8', false),
  ('neon-pop', 6, 'Valkyrie Helm', 540000, 'epic', 58535, 1365767, 'bighead:#9aa3b8', false),
  ('neon-pop', 7, 'Wanwood Antlers', 630000, 'epic', 66246, 1272714, 'bighead:#9aa3b8', false),
  ('neon-pop', 8, 'Ice Valkyrie', 738000, 'epic', 75219, 4390891467, 'bighead:#9aa3b8', false),
  ('neon-pop', 9, 'Pink Queen of the Night', 1026000, 'legendary', 26050, 553971558, 'bighead:#9aa3b8', true),
  ('neon-pop', 10, 'Neon Purple Crazy Crown', 1116000, 'legendary', 23950, 376805769, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, '9,600 Coins', 9600, 'common', 140000, 0, 'coins', false),
  ('crystal-beats', 1, 'Hotdog Head', 35800, 'common', 14713, 15318156, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'Pin Head', 56100, 'common', 38988, 25880554, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'Even Eviler Jester', 106700, 'common', 157268, 40893465, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'The Ice Skull of Nevermoor', 180000, 'uncommon', 489031, 6552254, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'Ice Valkyrie', 738000, 'epic', 30628, 4390891467, 'bighead:#9aa3b8', false),
  ('crystal-beats', 6, 'Brighteyes'' Bloxy Cola Hat', 900000, 'epic', 42989, 24114402, 'bighead:#9aa3b8', false),
  ('crystal-beats', 7, 'Eyes of Emeraldwrath', 1260000, 'epic', 76383, 209994352, 'bighead:#9aa3b8', false),
  ('crystal-beats', 8, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 5714, 188888052, 'bighead:#9aa3b8', true),
  ('crystal-beats', 9, 'Retro 80s Headphones', 2520000, 'legendary', 4286, 29844011, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Hotdog Head', 35800, 'common', 6543, 15318156, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Pin Head', 56100, 'common', 16851, 25880554, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'Even Eviler Jester', 106700, 'common', 65261, 40893465, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Korblox King', 168200, 'uncommon', 170198, 52492417, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Monstars Visor', 270000, 'uncommon', 461148, 1086815, 'bighead:#9aa3b8', false),
  ('lime-grin', 5, 'Valkyrie Helm', 540000, 'rare', 94064, 1365767, 'bighead:#9aa3b8', false),
  ('lime-grin', 6, 'Wanwood Antlers', 630000, 'epic', 82979, 1272714, 'bighead:#9aa3b8', false),
  ('lime-grin', 7, 'Ice Valkyrie', 738000, 'epic', 72957, 4390891467, 'bighead:#9aa3b8', false),
  ('lime-grin', 8, 'Crazy Glasses', 1350000, 'legendary', 15484, 16646369, 'bighead:#9aa3b8', true),
  ('lime-grin', 9, 'Clockwork''s Headphones', 1440000, 'legendary', 14516, 1235488, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 134893, 6552254, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'JJ5x5''s White Top Hat', 243000, 'uncommon', 186358, 1073690, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'Monstars Visor', 270000, 'uncommon', 208749, 1086815, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'Wanwood Antlers', 630000, 'rare', 24668, 1272714, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'Ice Valkyrie', 738000, 'rare', 98695, 4390891467, 'bighead:#9aa3b8', false),
  ('mistletoe', 5, 'Silver King of the Night', 846000, 'epic', 326637, 439945661, 'bighead:#9aa3b8', false),
  ('mistletoe', 6, 'Green Ice Crown', 954000, 'legendary', 11719, 193696233, 'bighead:#9aa3b8', true),
  ('mistletoe', 7, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 8281, 149594212, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, '16,000 Coins', 16000, 'common', 330000, 0, 'coins', false),
  ('winter-crown', 1, 'Golden Chakram of the Sky Palace', 77000, 'common', 7361, 47597760, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Even Eviler Jester', 106700, 'common', 16331, 40893465, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'The Ice Skull of Nevermoor', 180000, 'common', 58582, 6552254, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Monstars Visor', 270000, 'uncommon', 157725, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Ice Valkyrie', 738000, 'rare', 49460, 4390891467, 'bighead:#9aa3b8', false),
  ('winter-crown', 6, 'Silver King of the Night', 846000, 'epic', 109651, 439945661, 'bighead:#9aa3b8', false),
  ('winter-crown', 7, 'Green Ice Crown', 954000, 'epic', 220889, 193696233, 'bighead:#9aa3b8', false),
  ('winter-crown', 8, 'Hooded Frostlord', 1800000, 'legendary', 26190, 136802867, 'bighead:#9aa3b8', true),
  ('winter-crown', 9, 'Red Crown of Ozymandias', 1980000, 'legendary', 23810, 9465511, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'Valkyrie Helm', 540000, 'uncommon', 314346, 1365767, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'Ice Valkyrie', 738000, 'uncommon', 160712, 4390891467, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'Brighteyes'' Lavender Egg of Anticipation', 900000, 'rare', 104942, 24485062, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Wanwood Sombrero', 1044000, 'rare', 153043, 156105465, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Neon Purple Crazy Crown', 1116000, 'rare', 141285, 376805769, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'Dominus Praefectus', 1422000, 'epic', 105671, 527365852, 'bighead:#9aa3b8', false),
  ('violet-beats', 6, 'Neon Green Crazy Crown', 2430000, 'legendary', 10182, 321346616, 'bighead:#9aa3b8', true),
  ('violet-beats', 7, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 9818, 188004500, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'Lava Reactor', 101800, 'common', 149344, 32858948, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'The Ice Skull of Nevermoor', 180000, 'common', 146651, 6552254, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'Monstars Visor', 270000, 'common', 144765, 1086815, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Ice Valkyrie', 738000, 'uncommon', 140192, 4390891467, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Green Ice Crown', 954000, 'rare', 139048, 193696233, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'ColdLika: Snowman', 1440000, 'epic', 65091, 568921483, 'bighead:#9aa3b8', false),
  ('glacier', 6, 'Hooded Frostlord', 1800000, 'epic', 92454, 136802867, 'bighead:#9aa3b8', false),
  ('glacier', 7, 'Hooded Frostlord', 1800000, 'epic', 92454, 136802867, 'bighead:#9aa3b8', false),
  ('glacier', 8, 'Chronomalum: The Wicked Helm', 3510000, 'legendary', 15190, 215719463, 'bighead:#9aa3b8', true),
  ('glacier', 9, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 14810, 74891470, 'bighead:#9aa3b8', true),
  ('evergreen', 0, '30,000 Coins', 30000, 'common', 330000, 0, 'coins', false),
  ('evergreen', 1, 'Super Super Happy Face', 162000, 'common', 2240, 494291269, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'JJ5x5''s White Top Hat', 243000, 'common', 7321, 1073690, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Valkyrie Helm', 540000, 'uncommon', 75381, 1365767, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Brighteyes'' Bloxy Cola Hat', 900000, 'rare', 335058, 24114402, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Eyes of Emeraldwrath', 1260000, 'rare', 45402, 209994352, 'bighead:#9aa3b8', false),
  ('evergreen', 6, 'Helm of the Great Tree', 1350000, 'rare', 52145, 9910420, 'bighead:#9aa3b8', false),
  ('evergreen', 7, 'CW Ultimate: Sapphire Serenity', 1890000, 'epic', 102453, 188888052, 'bighead:#9aa3b8', false),
  ('evergreen', 8, 'Yellow Glowing Eyes', 3240000, 'legendary', 26923, 416846000, 'bighead:#9aa3b8', true),
  ('evergreen', 9, 'Green Glowing Eyes', 3780000, 'legendary', 23077, 398676450, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'Valkyrie Helm', 540000, 'common', 1072, 1365767, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'Ice Valkyrie', 738000, 'uncommon', 9348, 4390891467, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'Helm of the Sacred Earth', 900000, 'uncommon', 37011, 22157971, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Headdress of Aken-Aten, the Sun King', 1080000, 'uncommon', 131025, 18482398, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'The Fire Crown', 1260000, 'uncommon', 381544, 362032819, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Hooded Frostlord', 1800000, 'rare', 139079, 136802867, 'bighead:#9aa3b8', false),
  ('fire-ice', 6, 'Hooded Frostlord', 1800000, 'rare', 139079, 136802867, 'bighead:#9aa3b8', false),
  ('fire-ice', 7, 'Red Crown of Ozymandias', 1980000, 'rare', 141841, 9465511, 'bighead:#9aa3b8', false),
  ('fire-ice', 8, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 10476, 74891470, 'bighead:#9aa3b8', true),
  ('fire-ice', 9, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 9524, 215718515, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 19045, 6552254, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'Monstars Visor', 270000, 'common', 30327, 1086815, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Valkyrie Helm', 540000, 'common', 67177, 1365767, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'Green Ice Crown', 954000, 'uncommon', 129061, 193696233, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'A Dark Presence', 1440000, 'uncommon', 206996, 20908915, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Hooded Frostlord', 1800000, 'rare', 267395, 136802867, 'bighead:#9aa3b8', false),
  ('black-ice', 6, 'Vaiobot''s Moneylicious Tie', 2250000, 'rare', 86660, 30371876, 'bighead:#9aa3b8', false),
  ('black-ice', 7, 'Mighty Mask of Zeus', 2340000, 'rare', 85766, 13793866, 'bighead:#9aa3b8', false),
  ('black-ice', 8, 'Azurewrath, Lord of the Void', 3420000, 'epic', 77574, 17109706, 'bighead:#9aa3b8', false),
  ('black-ice', 9, 'The Void Star', 5580000, 'legendary', 16901, 1125510, 'bighead:#9aa3b8', true),
  ('black-ice', 10, 'The Ice Crown', 7200000, 'legendary', 13099, 1323384, 'bighead:#9aa3b8', true),
  ('amethyst', 0, '140,000 Coins', 140000, 'common', 380000, 0, 'coins', false),
  ('amethyst', 1, 'Wanwood Antlers', 630000, 'common', 25214, 1272714, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'Pink Queen of the Night', 1026000, 'common', 51491, 553971558, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'Hooded Frostlord', 1800000, 'uncommon', 117256, 136802867, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Steampunk Bobbie', 3150000, 'uncommon', 266040, 140484519, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'epic', 4253, 315549204, 'bighead:#9aa3b8', false),
  ('amethyst', 6, 'Lady of the Federation', 9900000, 'epic', 19720, 207207782, 'bighead:#9aa3b8', false),
  ('amethyst', 7, 'Orange Sparkle Time Fedora', 17100000, 'epic', 126026, 215751161, 'bighead:#9aa3b8', false),
  ('amethyst', 8, '): Euro 180', 22500000, 'legendary', 6154, 23705521, 'bighead:#9aa3b8', true),
  ('amethyst', 9, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 3846, 63043890, 'bighead:#9aa3b8', true),
  ('jade', 0, '150,000 Coins', 150000, 'common', 330000, 0, 'coins', false),
  ('jade', 1, 'Ice Valkyrie', 738000, 'common', 46, 4390891467, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Eyes of Emeraldwrath', 1260000, 'common', 821, 209994352, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Spec Epsilon Biograft Energy Sword', 1710000, 'common', 4253, 23727705, 'bighead:#9aa3b8', false),
  ('jade', 4, 'Green Bow Tie', 2700000, 'uncommon', 49803, 16598513, 'bighead:#9aa3b8', false),
  ('jade', 5, 'Green Glowing Eyes', 3780000, 'uncommon', 305077, 398676450, 'bighead:#9aa3b8', false),
  ('jade', 6, 'Ghosdeeri', 5220000, 'rare', 4895, 183468963, 'bighead:#9aa3b8', false),
  ('jade', 7, 'Gaze of Socom1880', 6120000, 'rare', 15250, 14671091, 'bighead:#9aa3b8', false),
  ('jade', 8, 'Telamon Hair', 9000000, 'epic', 239855, 31312357, 'bighead:#9aa3b8', false),
  ('jade', 9, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 25641, 215751161, 'bighead:#9aa3b8', true),
  ('jade', 10, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 24359, 147180077, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Chrononoctis: The Ominous Helm', 2790000, 'common', 45029, 161211371, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'Azurewrath, Lord of the Void', 3420000, 'uncommon', 62233, 17109706, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Sparkle Time Fedora', 4500000, 'uncommon', 96261, 1285307, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'Gaze of Socom1880', 6120000, 'uncommon', 156923, 14671091, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Hooded Firelord', 7560000, 'rare', 219554, 144507154, 'bighead:#9aa3b8', false),
  ('sapphire', 5, 'Telamon Hair', 9000000, 'rare', 136119, 31312357, 'bighead:#9aa3b8', false),
  ('sapphire', 6, 'Telamon Hair', 9000000, 'rare', 136119, 31312357, 'bighead:#9aa3b8', false),
  ('sapphire', 7, '): Red Grind', 11700000, 'rare', 127763, 20573086, 'bighead:#9aa3b8', false),
  ('sapphire', 8, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 10667, 489196035, 'bighead:#9aa3b8', true),
  ('sapphire', 9, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 9333, 493476042, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'Crown of Tones', 1188000, 'common', 10028, 152173424, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Red Crown of Ozymandias', 1980000, 'common', 27673, 9465511, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'Crown of Om Nom Nom', 3060000, 'common', 65727, 21070350, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Sparkle Time Fedora', 4500000, 'uncommon', 141441, 1285307, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'Red Glowing Eyes', 8280000, 'uncommon', 475131, 180660043, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'The Crown of Roses', 13500000, 'rare', 78781, 17449820, 'bighead:#9aa3b8', false),
  ('sunset-remix', 6, 'The Wanwood Crown', 14400000, 'rare', 80341, 9910070, 'bighead:#9aa3b8', false),
  ('sunset-remix', 7, 'Sky Blue Sparkle Time Fedora', 21600000, 'epic', 90878, 493476042, 'bighead:#9aa3b8', false),
  ('sunset-remix', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 16364, 63043890, 'bighead:#9aa3b8', true),
  ('sunset-remix', 9, 'Domino Crown', 43200000, 'legendary', 13636, 1031429, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'Purple Sparkle Time Fedora', 36000000, 'uncommon', 211845, 63043890, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'Domino Crown', 43200000, 'uncommon', 182109, 1031429, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, 'Black Sparkle Time Fedora', 45000000, 'uncommon', 176046, 259423244, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'Dominus Astra', 108000000, 'rare', 199422, 162067148, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Dominus Infernus', 126000000, 'epic', 210578, 31101391, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Dominus Frigidus', 162000000, 'legendary', 11000, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 6, 'Dominus Empyreus', 198000000, 'legendary', 9000, 21070012, 'bighead:#9aa3b8', true);

-- Leaderboard: admins can hide a player (their wagers stop counting and they vanish from the board)
alter table public.profiles add column if not exists lb_hidden boolean not null default false;

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
  if coalesce((select lb_hidden from public.profiles where id = p_uid), false) then return; end if;
  insert into public.weekly_wagers (week_start, user_id, wagered, updated_at)
  values (public.lb_week(), p_uid, p_amount, now())
  on conflict (week_start, user_id) do update
    set wagered = public.weekly_wagers.wagered + excluded.wagered, updated_at = now();
end $$;


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
        from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)
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


create or replace function public.get_leaderboard()
returns json language plpgsql volatile security definer set search_path = public as $$
declare w date := public.lb_week(); prizes bigint[] := public.lb_prizes(); v_me json; v_top json; v_last json;
begin
  perform public.lb_settle();
  select coalesce(json_agg(t order by t.rank), '[]') into v_top from (
    select row_number() over (order by ww.wagered desc, ww.updated_at) as rank, ww.user_id, p.username, ww.wagered,
           public.level_of(p.wagered) as level
      from public.weekly_wagers ww join public.profiles p on p.id = ww.user_id
     where ww.week_start = w and ww.wagered > 0 and not p.lb_hidden
     order by ww.wagered desc, ww.updated_at limit 50) t;
  if auth.uid() is not null then
    select json_build_object('rank', t.rank, 'wagered', coalesce(t.wagered, 0)) into v_me from (
      select rank, wagered from (
        select user_id, wagered, row_number() over (order by wagered desc, updated_at) as rank
          from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)) x
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


create or replace function public.admin_set_lb_hidden(p_user uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.profiles set lb_hidden = p_hidden where id = p_user;
end $$;

create or replace function public.admin_find(p_q text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(json_agg(t order by t.wagered desc), '[]') from (
    select p.id, p.username, u.email, p.coins, p.wagered, p.created_at, p.is_admin, p.lb_hidden
      from public.profiles p left join auth.users u on u.id = p.id
     where p_q is null or p_q = '' or p.username ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
     order by p.wagered desc limit 25) t);
end $$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[], boolean, boolean, boolean), public.battle_join(uuid, int, boolean), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume(),
  public.admin_stats(), public.admin_find(text), public.admin_coins(uuid, bigint), public.admin_set_admin(uuid, boolean), public.admin_delete_chat(bigint), public.admin_set_lb_hidden(uuid, boolean)
  to authenticated;

-- =====================================================================
-- Included: update 10 (case odds: gold dice prizes)
-- =====================================================================

insert into public.cases (id, name, sort, price, image, active) values
  ('peppermint', 'Peppermint', 100, 600, 'assets/cases/peppermint.webp', true),
  ('crystal-egg', 'Crystal Egg', 101, 700, 'assets/cases/crystal-egg.webp', true),
  ('faberge', 'Fabergé', 102, 1000, 'assets/cases/faberge.webp', true),
  ('zombie-horde', 'Zombie Horde', 103, 1200, 'assets/cases/zombie-horde.webp', true),
  ('haunted-patch', 'Haunted Patch', 104, 1500, 'assets/cases/haunted-patch.webp', true),
  ('fiesta', 'Fiesta', 105, 2000, 'assets/cases/fiesta.webp', true),
  ('overgrown', 'Overgrown', 106, 2500, 'assets/cases/overgrown.webp', true),
  ('dragon-hatch', 'Dragon Hatch', 107, 3000, 'assets/cases/dragon-hatch.webp', true),
  ('orbit', 'Orbit', 108, 3900, 'assets/cases/orbit.webp', true),
  ('martian', 'Martian', 109, 5000, 'assets/cases/martian.webp', true),
  ('blue-grin', 'Blue Grin', 110, 5200, 'assets/cases/blue-grin.webp', true),
  ('gearhead', 'Gearhead', 111, 6500, 'assets/cases/gearhead.webp', true),
  ('gilded-night', 'Gilded Night', 112, 6600, 'assets/cases/gilded-night.webp', true),
  ('spooky-beats', 'Spooky Beats', 113, 8000, 'assets/cases/spooky-beats.webp', true),
  ('atlantis', 'Atlantis', 114, 9100, 'assets/cases/atlantis.webp', true),
  ('ember', 'Ember', 115, 9800, 'assets/cases/ember.webp', true),
  ('topaz', 'Topaz', 116, 10000, 'assets/cases/topaz.webp', true),
  ('tide-blade', 'Tide Blade', 117, 12000, 'assets/cases/tide-blade.webp', true),
  ('brass-samurai', 'Brass Samurai', 118, 15000, 'assets/cases/brass-samurai.webp', true),
  ('bubblegum-grin', 'Bubblegum Grin', 119, 16000, 'assets/cases/bubblegum-grin.webp', true),
  ('shogun', 'Shogun', 120, 20000, 'assets/cases/shogun.webp', true),
  ('golden-snow', 'Golden Snow', 121, 21000, 'assets/cases/golden-snow.webp', true),
  ('frostbite', 'Frostbite', 122, 22000, 'assets/cases/frostbite.webp', true),
  ('pop-art', 'Pop Art', 123, 23000, 'assets/cases/pop-art.webp', true),
  ('jurassic', 'Jurassic', 124, 25000, 'assets/cases/jurassic.webp', true),
  ('midnight-holly', 'Midnight Holly', 125, 29000, 'assets/cases/midnight-holly.webp', true),
  ('viking-ember', 'Viking Ember', 126, 34000, 'assets/cases/viking-ember.webp', true),
  ('nevermoor', 'Nevermoor', 127, 50000, 'assets/cases/nevermoor.webp', true),
  ('smiley', 'Smiley', 128, 65000, 'assets/cases/smiley.webp', true),
  ('tropical-pop', 'Tropical Pop', 129, 68000, 'assets/cases/tropical-pop.webp', true),
  ('retro-wave', 'Retro Wave', 130, 72000, 'assets/cases/retro-wave.webp', true),
  ('eclipse', 'Eclipse', 131, 75000, 'assets/cases/eclipse.webp', true),
  ('shadow-beats', 'Shadow Beats', 132, 110000, 'assets/cases/shadow-beats.webp', true),
  ('arctic-moss', 'Arctic Moss', 133, 180000, 'assets/cases/arctic-moss.webp', true),
  ('sunbeam', 'Sunbeam', 134, 220000, 'assets/cases/sunbeam.webp', true),
  ('neon-pop', 'Neon Pop', 135, 310000, 'assets/cases/neon-pop.webp', true),
  ('crystal-beats', 'Crystal Beats', 136, 320000, 'assets/cases/crystal-beats.webp', true),
  ('lime-grin', 'Lime Grin', 137, 400000, 'assets/cases/lime-grin.webp', true),
  ('mistletoe', 'Mistletoe', 138, 540000, 'assets/cases/mistletoe.webp', true),
  ('winter-crown', 'Winter Crown', 139, 550000, 'assets/cases/winter-crown.webp', true),
  ('violet-beats', 'Violet Beats', 140, 1000000, 'assets/cases/violet-beats.webp', true),
  ('glacier', 'Glacier', 141, 1000000, 'assets/cases/glacier.webp', true),
  ('evergreen', 'Evergreen', 142, 1000000, 'assets/cases/evergreen.webp', true),
  ('fire-ice', 'Fire Ice', 143, 1600000, 'assets/cases/fire-ice.webp', true),
  ('black-ice', 'Black Ice', 144, 1700000, 'assets/cases/black-ice.webp', true),
  ('amethyst', 'Amethyst', 145, 2800000, 'assets/cases/amethyst.webp', true),
  ('jade', 'Jade', 146, 5000000, 'assets/cases/jade.webp', true),
  ('sapphire', 'Sapphire', 147, 6500000, 'assets/cases/sapphire.webp', true),
  ('sunset-remix', 'Sunset Remix', 148, 7600000, 'assets/cases/sunset-remix.webp', true),
  ('ultimate-grin', 'Ultimate Grin', 149, 28000000, 'assets/cases/ultimate-grin.webp', true)
on conflict (id) do update set name = excluded.name, sort = excluded.sort, price = excluded.price, image = excluded.image, active = true;

delete from public.case_items where case_id in ('peppermint','crystal-egg','faberge','zombie-horde','haunted-patch','fiesta','overgrown','dragon-hatch','orbit','martian','blue-grin','gearhead','gilded-night','spooky-beats','atlantis','ember','topaz','tide-blade','brass-samurai','bubblegum-grin','shogun','golden-snow','frostbite','pop-art','jurassic','midnight-holly','viking-ember','nevermoor','smiley','tropical-pop','retro-wave','eclipse','shadow-beats','arctic-moss','sunbeam','neon-pop','crystal-beats','lime-grin','mistletoe','winter-crown','violet-beats','glacier','evergreen','fire-ice','black-ice','amethyst','jade','sapphire','sunset-remix','ultimate-grin');

insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('peppermint', 0, '20 Coins', 20, 'common', 120000, 0, 'coins', false),
  ('peppermint', 1, 'Zipper Cap', 400, 'uncommon', 565658, 51245998, 'bighead:#9aa3b8', false),
  ('peppermint', 2, 'Chrome Egg of Speeding Bullet', 500, 'rare', 96003, 24826640, 'bighead:#9aa3b8', false),
  ('peppermint', 3, 'Rusty Egg of Magnetism', 600, 'rare', 60222, 24826787, 'bighead:#9aa3b8', false),
  ('peppermint', 4, 'Chaos Canyon Sugar Egg', 700, 'rare', 55915, 76692143, 'bighead:#9aa3b8', false),
  ('peppermint', 5, 'Guardia in Exile', 800, 'epic', 55202, 18174901, 'bighead:#9aa3b8', false),
  ('peppermint', 6, 'Snowflake Winter Cap', 1400, 'legendary', 15000, 42846005, 'bighead:#9aa3b8', true),
  ('peppermint', 7, 'Spring into Christmas', 1800, 'legendary', 12000, 67995955, 'bighead:#9aa3b8', true),
  ('peppermint', 8, 'Blue Winter Cap', 3500, 'legendary', 10000, 1309918, 'bighead:#9aa3b8', true),
  ('peppermint', 9, 'Sci-Fi Santa', 4500, 'legendary', 6000, 18729820, 'bighead:#9aa3b8', true),
  ('peppermint', 10, '2010 Party Cap', 7100, 'legendary', 3000, 20044751, 'bighead:#9aa3b8', true),
  ('peppermint', 11, 'Bucket', 18000, 'legendary', 1000, 1081239, 'bighead:#9aa3b8', true),
  ('crystal-egg', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 319199, 24826737, 'bighead:#9aa3b8', false),
  ('crystal-egg', 1, 'Chrome Egg of Speeding Bullet', 500, 'rare', 199045, 24826640, 'bighead:#9aa3b8', false),
  ('crystal-egg', 2, 'Rusty Egg of Magnetism', 600, 'rare', 142752, 24826787, 'bighead:#9aa3b8', false),
  ('crystal-egg', 3, 'Chaos Canyon Sugar Egg', 700, 'rare', 112713, 76692143, 'bighead:#9aa3b8', false),
  ('crystal-egg', 4, 'Guardia in Exile', 800, 'rare', 95145, 18174901, 'bighead:#9aa3b8', false),
  ('crystal-egg', 5, 'Racing Helmet', 900, 'epic', 84146, 6379764, 'bighead:#9aa3b8', false),
  ('crystal-egg', 6, 'Stationary Egg of Boring', 1200, 'legendary', 15000, 1530795, 'bighead:#9aa3b8', true),
  ('crystal-egg', 7, 'Starry Egg of the Wild Ride', 1500, 'legendary', 12000, 31151864, 'bighead:#9aa3b8', true),
  ('crystal-egg', 8, 'Ethereal Ghost Egg', 2000, 'legendary', 10000, 76692331, 'bighead:#9aa3b8', true),
  ('crystal-egg', 9, 'Puzzling Egg of Enigma', 2600, 'legendary', 6000, 1532386, 'bighead:#9aa3b8', true),
  ('crystal-egg', 10, 'Green Fabergé Egg', 3300, 'legendary', 3000, 24832637, 'bighead:#9aa3b8', true),
  ('crystal-egg', 11, 'Invisible Egg of Shadow', 4900, 'legendary', 1000, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 0, '30 Coins', 30, 'common', 250000, 0, 'coins', false),
  ('faberge', 1, 'POW! To the Moon! Egg', 400, 'uncommon', 186510, 24826737, 'bighead:#9aa3b8', false),
  ('faberge', 2, 'Rusty Egg of Magnetism', 600, 'uncommon', 158685, 24826787, 'bighead:#9aa3b8', false),
  ('faberge', 3, 'Sword Fight on the Heights Sugar Egg', 1000, 'rare', 131851, 76692611, 'bighead:#9aa3b8', false),
  ('faberge', 4, 'Stationary Egg of Boring', 1200, 'epic', 124060, 1530795, 'bighead:#9aa3b8', false),
  ('faberge', 5, 'Turbo Builders Club Hard Hat', 1300, 'epic', 120894, 11844853, 'bighead:#9aa3b8', false),
  ('faberge', 6, 'Fried Egg Eye Patch', 3100, 'legendary', 10000, 63647492, 'bighead:#9aa3b8', true),
  ('faberge', 7, 'Invisible Egg of Shadow', 4900, 'legendary', 8000, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 8, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 5000, 10351018, 'bighead:#9aa3b8', true),
  ('faberge', 9, 'Mick McCann', 21100, 'legendary', 3000, 23264604, 'bighead:#9aa3b8', true),
  ('faberge', 10, 'Viridian Hood', 41200, 'legendary', 1500, 16954107, 'bighead:#9aa3b8', true),
  ('faberge', 11, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 500, 47597760, 'bighead:#9aa3b8', true),
  ('zombie-horde', 0, '40 Coins', 40, 'common', 250000, 0, 'coins', false),
  ('zombie-horde', 1, 'POW! To the Moon! Egg', 400, 'uncommon', 236625, 24826737, 'bighead:#9aa3b8', false),
  ('zombie-horde', 2, 'Chaos Canyon Sugar Egg', 700, 'uncommon', 160437, 76692143, 'bighead:#9aa3b8', false),
  ('zombie-horde', 3, 'Radioactive Egg of Undead Apocalypse', 1200, 'rare', 117447, 24826704, 'bighead:#9aa3b8', false),
  ('zombie-horde', 4, 'Starry Egg of the Wild Ride', 1500, 'epic', 105273, 31151864, 'bighead:#9aa3b8', false),
  ('zombie-horde', 5, 'Outrageous Builders Club Hard Hat', 1600, 'epic', 102217, 17408283, 'bighead:#9aa3b8', false),
  ('zombie-horde', 6, 'Halloween Harbinger', 3300, 'legendary', 10000, 15727771, 'bighead:#9aa3b8', true),
  ('zombie-horde', 7, 'Halloween Santa Hat', 7100, 'legendary', 8000, 1173851, 'bighead:#9aa3b8', true),
  ('zombie-horde', 8, 'Camoface', 12000, 'legendary', 5000, 24441888, 'bighead:#9aa3b8', true),
  ('zombie-horde', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 3000, 20980122, 'bighead:#9aa3b8', true),
  ('zombie-horde', 10, 'The Crown of Nachos', 44100, 'legendary', 1500, 22547617, 'bighead:#9aa3b8', true),
  ('zombie-horde', 11, 'Lava Reactor', 101800, 'legendary', 500, 32858948, 'bighead:#9aa3b8', true),
  ('haunted-patch', 0, 'POW! To the Moon! Egg', 400, 'common', 315460, 24826737, 'bighead:#9aa3b8', false),
  ('haunted-patch', 1, 'Rusty Egg of Magnetism', 600, 'uncommon', 213003, 24826787, 'bighead:#9aa3b8', false),
  ('haunted-patch', 2, 'Arctic Hood', 1000, 'uncommon', 139174, 18171366, 'bighead:#9aa3b8', false),
  ('haunted-patch', 3, 'Double Rainbow', 1700, 'rare', 98762, 35246042, 'bighead:#9aa3b8', false),
  ('haunted-patch', 4, 'Blinking Egg of Relocation', 1800, 'epic', 95784, 1532381, 'bighead:#9aa3b8', false),
  ('haunted-patch', 5, 'Harbinger of the Neverending Winter', 2000, 'epic', 90817, 62720331, 'bighead:#9aa3b8', false),
  ('haunted-patch', 6, 'Halloween Harbinger', 3300, 'legendary', 15000, 15727771, 'bighead:#9aa3b8', true),
  ('haunted-patch', 7, 'Sci-Fi Santa', 4500, 'legendary', 12000, 18729820, 'bighead:#9aa3b8', true),
  ('haunted-patch', 8, 'Halloween Santa Hat', 7100, 'legendary', 10000, 1173851, 'bighead:#9aa3b8', true),
  ('haunted-patch', 9, 'Camoface', 12000, 'legendary', 6000, 24441888, 'bighead:#9aa3b8', true),
  ('haunted-patch', 10, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 3000, 1285300, 'bighead:#9aa3b8', true),
  ('haunted-patch', 11, 'The Crown of Nachos', 44100, 'legendary', 1000, 22547617, 'bighead:#9aa3b8', true),
  ('fiesta', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 157794, 24826640, 'bighead:#9aa3b8', false),
  ('fiesta', 1, 'Mildly Disturbing Mask', 1000, 'uncommon', 158465, 33810096, 'bighead:#9aa3b8', false),
  ('fiesta', 2, '2010 Fireworks', 1300, 'uncommon', 158720, 20064349, 'bighead:#9aa3b8', false),
  ('fiesta', 3, 'Ruby Serpent Mummy Mask', 2100, 'rare', 159188, 17450058, 'bighead:#9aa3b8', false),
  ('fiesta', 4, 'Puzzling Egg of Enigma', 2600, 'epic', 159397, 1532386, 'bighead:#9aa3b8', false),
  ('fiesta', 5, 'Target Hat', 2700, 'epic', 159434, 1051578, 'bighead:#9aa3b8', false),
  ('fiesta', 6, 'Ultimate Slide Skateboard', 3700, 'legendary', 15000, 52180878, 'bighead:#9aa3b8', true),
  ('fiesta', 7, 'Bloxxadore Domino Mask', 5200, 'legendary', 12000, 14492461, 'bighead:#9aa3b8', true),
  ('fiesta', 8, 'Black Paintball Mask', 6800, 'legendary', 10000, 9254521, 'bighead:#9aa3b8', true),
  ('fiesta', 9, '2010 Party Cap', 7100, 'legendary', 6000, 20044751, 'bighead:#9aa3b8', true),
  ('fiesta', 10, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 3000, 10351018, 'bighead:#9aa3b8', true),
  ('fiesta', 11, 'Bucket', 18000, 'legendary', 1000, 1081239, 'bighead:#9aa3b8', true),
  ('overgrown', 0, '80 Coins', 80, 'common', 300000, 0, 'coins', false),
  ('overgrown', 1, 'POW! To the Moon! Egg', 400, 'common', 70612, 24826737, 'bighead:#9aa3b8', false),
  ('overgrown', 2, 'Guardia in Exile', 800, 'uncommon', 87801, 18174901, 'bighead:#9aa3b8', false),
  ('overgrown', 3, 'Earth Day 2011 Tie', 1700, 'uncommon', 128540, 50430337, 'bighead:#9aa3b8', false),
  ('overgrown', 4, 'Earth Day 2010 Cap', 2400, 'rare', 161398, 25977727, 'bighead:#9aa3b8', false),
  ('overgrown', 5, 'Halloween Harbinger', 3300, 'epic', 204648, 15727771, 'bighead:#9aa3b8', false),
  ('overgrown', 6, 'Treehugger Visor', 5700, 'legendary', 15000, 9910514, 'bighead:#9aa3b8', true),
  ('overgrown', 7, 'Mandrake Root', 10400, 'legendary', 12000, 1191812, 'bighead:#9aa3b8', true),
  ('overgrown', 8, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10000, 14817131, 'bighead:#9aa3b8', true),
  ('overgrown', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6000, 20980122, 'bighead:#9aa3b8', true),
  ('overgrown', 10, 'Viridian Hood', 41200, 'legendary', 3000, 16954107, 'bighead:#9aa3b8', true),
  ('overgrown', 11, 'Lava Reactor', 101800, 'legendary', 1000, 32858948, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 0, 'POW! To the Moon! Egg', 400, 'common', 118317, 24826737, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 132407, 76692143, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 2, 'Stationary Egg of Boring', 1200, 'uncommon', 148935, 1530795, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 3, 'Ethereal Ghost Egg', 2000, 'uncommon', 167845, 76692331, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 4, 'Fried Egg Eye Patch', 3100, 'rare', 187074, 63647492, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 5, 'Headrow', 3900, 'epic', 198422, 1082935, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 6, 'Invisible Egg of Shadow', 4900, 'legendary', 15000, 1532389, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 7, 'Robosquid', 9200, 'legendary', 12000, 37238566, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 8, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10000, 14817131, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6000, 20980122, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 10, 'The Crown of Nachos', 44100, 'legendary', 3000, 22547617, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 11, 'Playful Vampire', 90000, 'legendary', 1000, 2409285794, 'bighead:#9aa3b8', true),
  ('orbit', 0, '120 Coins', 120, 'common', 250000, 0, 'coins', false),
  ('orbit', 1, 'Racing Helmet', 900, 'common', 55039, 6379764, 'bighead:#9aa3b8', false),
  ('orbit', 2, 'Starry Egg of the Wild Ride', 1500, 'uncommon', 55866, 31151864, 'bighead:#9aa3b8', false),
  ('orbit', 3, 'Earth Day 2010 Cap', 2400, 'uncommon', 69953, 25977727, 'bighead:#9aa3b8', false),
  ('orbit', 4, 'The Moon', 2900, 'rare', 102085, 7319168, 'bighead:#9aa3b8', false),
  ('orbit', 5, 'The Earth', 4100, 'rare', 439056, 10072631, 'bighead:#9aa3b8', false),
  ('orbit', 6, 'Bag O'' Noobs', 11800, 'legendary', 10000, 32355759, 'bighead:#9aa3b8', true),
  ('orbit', 7, 'Seeing Stars', 18700, 'legendary', 8000, 27599954, 'bighead:#9aa3b8', true),
  ('orbit', 8, 'Viridian Hood', 41200, 'legendary', 5000, 16954107, 'bighead:#9aa3b8', true),
  ('orbit', 9, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 3000, 47597760, 'bighead:#9aa3b8', true),
  ('orbit', 10, 'Super Super Happy Face', 162000, 'legendary', 1500, 494291269, 'bighead:#9aa3b8', true),
  ('orbit', 11, 'Monstars Visor', 270000, 'legendary', 500, 1086815, 'bighead:#9aa3b8', true),
  ('martian', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 55000, 24826640, 'bighead:#9aa3b8', false),
  ('martian', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 55000, 76692143, 'bighead:#9aa3b8', false),
  ('martian', 2, 'Stationary Egg of Boring', 1200, 'common', 55002, 1530795, 'bighead:#9aa3b8', false),
  ('martian', 3, 'Christmas Baseball Cap', 2000, 'uncommon', 55187, 1272713, 'bighead:#9aa3b8', false),
  ('martian', 4, 'Green Fabergé Egg', 3300, 'uncommon', 69172, 24832637, 'bighead:#9aa3b8', false),
  ('martian', 5, 'Xenotargeting Oculus', 5100, 'rare', 663638, 14129301, 'bighead:#9aa3b8', false),
  ('martian', 6, 'Greenbot', 10200, 'legendary', 15000, 22023239, 'bighead:#9aa3b8', true),
  ('martian', 7, 'Ochre Ogre', 10900, 'legendary', 12000, 16723499, 'bighead:#9aa3b8', true),
  ('martian', 8, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10000, 14817131, 'bighead:#9aa3b8', true),
  ('martian', 9, 'Bucket', 18000, 'legendary', 6000, 1081239, 'bighead:#9aa3b8', true),
  ('martian', 10, 'Burning Otaku, the Firesouled', 24600, 'legendary', 3000, 20980122, 'bighead:#9aa3b8', true),
  ('martian', 11, 'Viridian Hood', 41200, 'legendary', 1000, 16954107, 'bighead:#9aa3b8', true),
  ('blue-grin', 0, '160 Coins', 160, 'common', 300000, 0, 'coins', false),
  ('blue-grin', 1, 'Shiny Gold Egg of Switcheroo', 500, 'common', 55316, 24826693, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Racing Helmet', 900, 'common', 56649, 6379764, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'Starry Egg of the Wild Ride', 1500, 'common', 61924, 31151864, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Blue Winter Cap', 3500, 'uncommon', 129799, 1309918, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'rare', 349311, 1483632, 'bighead:#9aa3b8', false),
  ('blue-grin', 6, 'Seeing Stars', 18700, 'legendary', 15000, 27599954, 'bighead:#9aa3b8', true),
  ('blue-grin', 7, 'Mick McCann', 21100, 'legendary', 12000, 23264604, 'bighead:#9aa3b8', true),
  ('blue-grin', 8, 'Hotdog Head', 35800, 'legendary', 10000, 15318156, 'bighead:#9aa3b8', true),
  ('blue-grin', 9, 'The Bluesteel Bathelm', 63000, 'legendary', 6000, 1172161, 'bighead:#9aa3b8', true),
  ('blue-grin', 10, 'Lava Reactor', 101800, 'legendary', 3000, 32858948, 'bighead:#9aa3b8', true),
  ('blue-grin', 11, 'The Ice Skull of Nevermoor', 180000, 'legendary', 1000, 6552254, 'bighead:#9aa3b8', true),
  ('gearhead', 0, '200 Coins', 200, 'common', 300000, 0, 'coins', false),
  ('gearhead', 1, 'Homemade Robot', 1500, 'common', 55000, 51243520, 'bighead:#9aa3b8', false),
  ('gearhead', 2, 'Silver Tetramino of Accomplishment', 2400, 'uncommon', 55000, 5786026, 'bighead:#9aa3b8', false),
  ('gearhead', 3, 'Rusty Tetramino of Competence', 3500, 'uncommon', 55000, 5785985, 'bighead:#9aa3b8', false),
  ('gearhead', 4, 'Invisible Egg of Shadow', 4900, 'rare', 55004, 1532389, 'bighead:#9aa3b8', false),
  ('gearhead', 5, 'Traffic Cone', 7200, 'rare', 432996, 1082932, 'bighead:#9aa3b8', false),
  ('gearhead', 6, 'Kid Robot', 12500, 'legendary', 15000, 29283299, 'bighead:#9aa3b8', true),
  ('gearhead', 7, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12000, 20980122, 'bighead:#9aa3b8', true),
  ('gearhead', 8, 'Golden Headphones', 52700, 'legendary', 10000, 29051524, 'bighead:#9aa3b8', true),
  ('gearhead', 9, 'Wildcard', 65400, 'legendary', 6000, 38322996, 'bighead:#9aa3b8', true),
  ('gearhead', 10, 'Even Eviler Jester', 106700, 'legendary', 3000, 40893465, 'bighead:#9aa3b8', true),
  ('gearhead', 11, 'Monstars Visor', 270000, 'legendary', 1000, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, '200 Coins', 200, 'common', 250000, 0, 'coins', false),
  ('gilded-night', 1, 'Shiny Gold Egg of Switcheroo', 500, 'common', 55933, 24826693, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Stationary Egg of Boring', 1200, 'common', 61555, 1530795, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'Your Head, a Marshmallow Floating in Hot Chocolate', 2600, 'uncommon', 91689, 19395368, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'Headrow', 3900, 'uncommon', 145525, 1082935, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'Black Paintball Mask', 6800, 'rare', 367298, 9254521, 'bighead:#9aa3b8', false),
  ('gilded-night', 6, 'Seeing Stars', 18700, 'legendary', 10000, 27599954, 'bighead:#9aa3b8', true),
  ('gilded-night', 7, 'Golden Headphones', 52700, 'legendary', 8000, 29051524, 'bighead:#9aa3b8', true),
  ('gilded-night', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 5000, 47597760, 'bighead:#9aa3b8', true),
  ('gilded-night', 9, 'Super Super Happy Face', 162000, 'legendary', 3000, 494291269, 'bighead:#9aa3b8', true),
  ('gilded-night', 10, 'Monstars Visor', 270000, 'legendary', 1500, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 11, 'Valkyrie Helm', 540000, 'legendary', 500, 1365767, 'bighead:#9aa3b8', true),
  ('spooky-beats', 0, 'Explosive Egg of Kaboom!', 800, 'common', 75625, 24826755, 'bighead:#9aa3b8', false),
  ('spooky-beats', 1, 'Stationary Egg of Boring', 1200, 'common', 86871, 1530795, 'bighead:#9aa3b8', false),
  ('spooky-beats', 2, 'Harbinger of the Neverending Winter', 2000, 'common', 110145, 62720331, 'bighead:#9aa3b8', false),
  ('spooky-beats', 3, 'Halloween Harbinger', 3300, 'uncommon', 149393, 15727771, 'bighead:#9aa3b8', false),
  ('spooky-beats', 4, 'Bloxxadore Domino Mask', 5200, 'uncommon', 208782, 14492461, 'bighead:#9aa3b8', false),
  ('spooky-beats', 5, 'Chemistry Textbook', 8700, 'rare', 322184, 1139753, 'bighead:#9aa3b8', false),
  ('spooky-beats', 6, 'Bucket', 18000, 'legendary', 15000, 1081239, 'bighead:#9aa3b8', true),
  ('spooky-beats', 7, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12000, 20980122, 'bighead:#9aa3b8', true),
  ('spooky-beats', 8, 'Golden Headphones', 52700, 'legendary', 10000, 29051524, 'bighead:#9aa3b8', true),
  ('spooky-beats', 9, 'The Bluesteel Bathelm', 63000, 'legendary', 6000, 1172161, 'bighead:#9aa3b8', true),
  ('spooky-beats', 10, 'Even Eviler Jester', 106700, 'legendary', 3000, 40893465, 'bighead:#9aa3b8', true),
  ('spooky-beats', 11, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1000, 1073690, 'bighead:#9aa3b8', true),
  ('atlantis', 0, 'Blue Fabergé Egg', 1200, 'common', 55089, 24830979, 'bighead:#9aa3b8', false),
  ('atlantis', 1, 'Blue Swashbuckler', 2200, 'common', 56055, 25535420, 'bighead:#9aa3b8', false),
  ('atlantis', 2, 'Blue Winter Cap', 3500, 'uncommon', 62011, 1309918, 'bighead:#9aa3b8', false),
  ('atlantis', 3, 'Swashbuckler', 4100, 'uncommon', 68368, 46363750, 'bighead:#9aa3b8', false),
  ('atlantis', 4, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'uncommon', 106253, 1483632, 'bighead:#9aa3b8', false),
  ('atlantis', 5, 'Black Iron Warhelm of Pwnage', 10200, 'rare', 605224, 10351018, 'bighead:#9aa3b8', false),
  ('atlantis', 6, 'Bucket', 18000, 'legendary', 15000, 1081239, 'bighead:#9aa3b8', true),
  ('atlantis', 7, 'Mick McCann', 21100, 'legendary', 12000, 23264604, 'bighead:#9aa3b8', true),
  ('atlantis', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 10000, 20980122, 'bighead:#9aa3b8', true),
  ('atlantis', 9, 'Hotdog Head', 35800, 'legendary', 6000, 15318156, 'bighead:#9aa3b8', true),
  ('atlantis', 10, 'The Crown of Nachos', 44100, 'legendary', 3000, 22547617, 'bighead:#9aa3b8', true),
  ('atlantis', 11, 'The Bluesteel Bathelm', 63000, 'legendary', 1000, 1172161, 'bighead:#9aa3b8', true),
  ('ember', 0, 'Racing Helmet', 900, 'common', 55006, 6379764, 'bighead:#9aa3b8', false),
  ('ember', 1, '2010 Fireworks', 1300, 'common', 55033, 20064349, 'bighead:#9aa3b8', false),
  ('ember', 2, 'Silver Tetramino of Accomplishment', 2400, 'common', 55573, 5786026, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Black Lightning', 4600, 'uncommon', 66925, 29532225, 'bighead:#9aa3b8', false),
  ('ember', 4, 'Black Paintball Mask', 6800, 'uncommon', 128888, 9254521, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Heat Vision Goggles', 10400, 'rare', 591575, 10748238, 'bighead:#9aa3b8', false),
  ('ember', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 15000, 20980122, 'bighead:#9aa3b8', true),
  ('ember', 7, 'Hotdog Head', 35800, 'legendary', 12000, 15318156, 'bighead:#9aa3b8', true),
  ('ember', 8, 'Viridian Hood', 41200, 'legendary', 10000, 16954107, 'bighead:#9aa3b8', true),
  ('ember', 9, 'Imagine', 41400, 'legendary', 6000, 30394316, 'bighead:#9aa3b8', true),
  ('ember', 10, 'Golden Headphones', 52700, 'legendary', 3000, 29051524, 'bighead:#9aa3b8', true),
  ('ember', 11, 'Lava Reactor', 101800, 'legendary', 1000, 32858948, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'Charles Babbage Fabergé Egg', 900, 'common', 60456, 76692101, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Starry Egg of the Wild Ride', 1500, 'common', 68043, 31151864, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'Red Fabergé Egg', 2300, 'common', 82047, 24832618, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'Golden Egg of Kings', 4200, 'uncommon', 130569, 1532387, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'Gold Buckle Capotain', 6200, 'uncommon', 201874, 5671970, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Mandrake Root', 10400, 'rare', 410010, 1191812, 'bighead:#9aa3b8', false),
  ('topaz', 6, 'Mick McCann', 21100, 'legendary', 15000, 23264604, 'bighead:#9aa3b8', true),
  ('topaz', 7, 'The Crown of Nachos', 44100, 'legendary', 12000, 22547617, 'bighead:#9aa3b8', true),
  ('topaz', 8, 'Golden Headphones', 52700, 'legendary', 10000, 29051524, 'bighead:#9aa3b8', true),
  ('topaz', 9, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 6000, 47597760, 'bighead:#9aa3b8', true),
  ('topaz', 10, 'Super Super Happy Face', 162000, 'legendary', 3000, 494291269, 'bighead:#9aa3b8', true),
  ('topaz', 11, 'Monstars Visor', 270000, 'legendary', 1000, 1086815, 'bighead:#9aa3b8', true),
  ('tide-blade', 0, '360 Coins', 360, 'common', 250000, 0, 'coins', false),
  ('tide-blade', 1, 'Sword Fight on the Heights Sugar Egg', 1000, 'common', 55004, 76692611, 'bighead:#9aa3b8', false),
  ('tide-blade', 2, 'The Axe of Undoing: A Walmart Exclusive', 2700, 'common', 55403, 73799348, 'bighead:#9aa3b8', false),
  ('tide-blade', 3, 'Deluxe Ninja Swordpack', 3100, 'common', 55757, 67996263, 'bighead:#9aa3b8', false),
  ('tide-blade', 4, 'Sword of Nefertiti', 8600, 'rare', 134931, 21802000, 'bighead:#9aa3b8', false),
  ('tide-blade', 5, 'Camoface', 12000, 'rare', 420905, 24441888, 'bighead:#9aa3b8', false),
  ('tide-blade', 6, 'Hotdog Head', 35800, 'legendary', 10000, 15318156, 'bighead:#9aa3b8', true),
  ('tide-blade', 7, 'Sword of the Winter Winds', 57600, 'legendary', 8000, 42847923, 'bighead:#9aa3b8', true),
  ('tide-blade', 8, 'Even Eviler Jester', 106700, 'legendary', 5000, 40893465, 'bighead:#9aa3b8', true),
  ('tide-blade', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3000, 1073690, 'bighead:#9aa3b8', true),
  ('tide-blade', 10, 'Valkyrie Helm', 540000, 'legendary', 1500, 1365767, 'bighead:#9aa3b8', true),
  ('tide-blade', 11, 'Spec Beta Biograft Energy Sword', 1260000, 'legendary', 500, 14876573, 'bighead:#9aa3b8', true),
  ('brass-samurai', 0, 'Turbo Builders Club Hard Hat', 1300, 'common', 73097, 11844853, 'bighead:#9aa3b8', false),
  ('brass-samurai', 1, 'Gold Tetramino of Mastery', 2700, 'common', 93810, 5786047, 'bighead:#9aa3b8', false),
  ('brass-samurai', 2, 'Guardia Helm', 3100, 'common', 99831, 17449403, 'bighead:#9aa3b8', false),
  ('brass-samurai', 3, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'uncommon', 139662, 1483632, 'bighead:#9aa3b8', false),
  ('brass-samurai', 4, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 210417, 10351018, 'bighead:#9aa3b8', false),
  ('brass-samurai', 5, 'Bucket', 18000, 'epic', 336182, 1081239, 'bighead:#9aa3b8', false),
  ('brass-samurai', 6, 'Hotdog Head', 35800, 'legendary', 15000, 15318156, 'bighead:#9aa3b8', true),
  ('brass-samurai', 7, 'Golden Headphones', 52700, 'legendary', 12000, 29051524, 'bighead:#9aa3b8', true),
  ('brass-samurai', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 10000, 47597760, 'bighead:#9aa3b8', true),
  ('brass-samurai', 9, 'Even Eviler Jester', 106700, 'legendary', 6000, 40893465, 'bighead:#9aa3b8', true),
  ('brass-samurai', 10, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3000, 1073690, 'bighead:#9aa3b8', true),
  ('brass-samurai', 11, 'Valkyrie Helm', 540000, 'legendary', 1000, 1365767, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, '480 Coins', 480, 'common', 300000, 0, 'coins', false),
  ('bubblegum-grin', 1, 'Violently Pink Egg of Violent Opinions', 2600, 'common', 55000, 24826771, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'I Heart Mom Sign', 4100, 'common', 55000, 10630526, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'Ladies Who Lunch', 5600, 'uncommon', 55000, 35167841, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'Mandrake Root', 10400, 'uncommon', 55000, 1191812, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Bucket', 18000, 'rare', 433000, 1081239, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 6, 'Bubble Trouble', 57600, 'legendary', 15000, 19264845, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 7, 'Sundae Best', 74600, 'legendary', 12000, 35685322, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 8, 'Lava Reactor', 101800, 'legendary', 10000, 32858948, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 9, 'Super Super Happy Face', 162000, 'legendary', 6000, 494291269, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 10, 'Monstars Visor', 270000, 'legendary', 3000, 1086815, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 11, 'Wanwood Antlers', 630000, 'legendary', 1000, 1272714, 'bighead:#9aa3b8', true),
  ('shogun', 0, '600 Coins', 600, 'common', 300000, 0, 'coins', false),
  ('shogun', 1, 'Sand Tempest Nomad', 2300, 'common', 55004, 17735309, 'bighead:#9aa3b8', false),
  ('shogun', 2, 'Guardia Helm', 3100, 'common', 55018, 17449403, 'bighead:#9aa3b8', false),
  ('shogun', 3, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 55415, 1483632, 'bighead:#9aa3b8', false),
  ('shogun', 4, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 63497, 10351018, 'bighead:#9aa3b8', false),
  ('shogun', 5, 'Mick McCann', 21100, 'rare', 424066, 23264604, 'bighead:#9aa3b8', false),
  ('shogun', 6, 'The Bluesteel Bathelm', 63000, 'legendary', 15000, 1172161, 'bighead:#9aa3b8', true),
  ('shogun', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12000, 47597760, 'bighead:#9aa3b8', true),
  ('shogun', 8, 'Even Eviler Jester', 106700, 'legendary', 10000, 40893465, 'bighead:#9aa3b8', true),
  ('shogun', 9, 'Picklace', 192600, 'legendary', 6000, 33615415, 'bighead:#9aa3b8', true),
  ('shogun', 10, 'Valkyrie Helm', 540000, 'legendary', 3000, 1365767, 'bighead:#9aa3b8', true),
  ('shogun', 11, 'Helm of the Sacred Earth', 900000, 'legendary', 1000, 22157971, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Harbinger of the Neverending Winter', 2000, 'common', 74427, 62720331, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Blue Winter Cap', 3500, 'common', 90851, 1309918, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Sci-Fi Santa', 4500, 'common', 102207, 18729820, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Halloween Santa Hat', 7100, 'uncommon', 132775, 1173851, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Jack Frost', 13700, 'uncommon', 214729, 43245104, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'rare', 338010, 1285300, 'bighead:#9aa3b8', false),
  ('golden-snow', 6, 'Golden Headphones', 52700, 'legendary', 15000, 29051524, 'bighead:#9aa3b8', true),
  ('golden-snow', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12000, 47597760, 'bighead:#9aa3b8', true),
  ('golden-snow', 8, 'Even Eviler Jester', 106700, 'legendary', 10000, 40893465, 'bighead:#9aa3b8', true),
  ('golden-snow', 9, 'Korblox King', 168200, 'legendary', 6000, 52492417, 'bighead:#9aa3b8', true),
  ('golden-snow', 10, 'Monstars Visor', 270000, 'legendary', 3000, 1086815, 'bighead:#9aa3b8', true),
  ('golden-snow', 11, 'Wanwood Antlers', 630000, 'legendary', 1000, 1272714, 'bighead:#9aa3b8', true),
  ('frostbite', 0, '660 Coins', 660, 'common', 250000, 0, 'coins', false),
  ('frostbite', 1, 'Harbinger of the Neverending Winter', 2000, 'common', 55043, 62720331, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Blue Winter Cap', 3500, 'common', 55344, 1309918, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 57118, 1483632, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Jack Frost', 13700, 'uncommon', 110552, 43245104, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'rare', 443943, 1285300, 'bighead:#9aa3b8', false),
  ('frostbite', 6, 'The Bluesteel Bathelm', 63000, 'legendary', 10000, 1172161, 'bighead:#9aa3b8', true),
  ('frostbite', 7, 'The Ice Skull of Nevermoor', 180000, 'legendary', 8000, 6552254, 'bighead:#9aa3b8', true),
  ('frostbite', 8, 'JJ5x5''s White Top Hat', 243000, 'legendary', 5000, 1073690, 'bighead:#9aa3b8', true),
  ('frostbite', 9, 'Valkyrie Helm', 540000, 'legendary', 3000, 1365767, 'bighead:#9aa3b8', true),
  ('frostbite', 10, 'Green Ice Crown', 954000, 'legendary', 1500, 193696233, 'bighead:#9aa3b8', true),
  ('frostbite', 11, 'Hooded Frostlord', 1800000, 'legendary', 500, 136802867, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Double Rainbow', 1700, 'common', 55189, 35246042, 'bighead:#9aa3b8', false),
  ('pop-art', 1, 'Halloween Harbinger', 3300, 'common', 56342, 15727771, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'Ladies Who Lunch', 5600, 'common', 61410, 35167841, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Traffic Cone', 7200, 'uncommon', 68474, 1082932, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 147218, 14817131, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Burning Otaku, the Firesouled', 24600, 'rare', 564367, 20980122, 'bighead:#9aa3b8', false),
  ('pop-art', 6, 'Wildcard', 65400, 'legendary', 15000, 38322996, 'bighead:#9aa3b8', true),
  ('pop-art', 7, 'Sundae Best', 74600, 'legendary', 12000, 35685322, 'bighead:#9aa3b8', true),
  ('pop-art', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 10000, 47597760, 'bighead:#9aa3b8', true),
  ('pop-art', 9, 'Playful Vampire', 90000, 'legendary', 6000, 2409285794, 'bighead:#9aa3b8', true),
  ('pop-art', 10, 'Even Eviler Jester', 106700, 'legendary', 3000, 40893465, 'bighead:#9aa3b8', true),
  ('pop-art', 11, 'Super Super Happy Face', 162000, 'legendary', 1000, 494291269, 'bighead:#9aa3b8', true),
  ('jurassic', 0, 'Santa Hat', 5800, 'common', 55011, 1098277, 'bighead:#9aa3b8', false),
  ('jurassic', 1, 'Das Deutschlandlied', 8400, 'uncommon', 55165, 26018282, 'bighead:#9aa3b8', false),
  ('jurassic', 2, 'Ochre Ogre', 10900, 'uncommon', 56132, 16723499, 'bighead:#9aa3b8', false),
  ('jurassic', 3, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 61480, 14817131, 'bighead:#9aa3b8', false),
  ('jurassic', 4, 'Mick McCann', 21100, 'rare', 204664, 23264604, 'bighead:#9aa3b8', false),
  ('jurassic', 5, 'Burning Otaku, the Firesouled', 24600, 'rare', 520547, 20980122, 'bighead:#9aa3b8', false),
  ('jurassic', 6, 'The Crown of Nachos', 44100, 'legendary', 15000, 22547617, 'bighead:#9aa3b8', true),
  ('jurassic', 7, 'Pin Head', 56100, 'legendary', 12000, 25880554, 'bighead:#9aa3b8', true),
  ('jurassic', 8, 'Sundae Best', 74600, 'legendary', 10000, 35685322, 'bighead:#9aa3b8', true),
  ('jurassic', 9, 'Playful Vampire', 90000, 'legendary', 6000, 2409285794, 'bighead:#9aa3b8', true),
  ('jurassic', 10, 'Even Eviler Jester', 106700, 'legendary', 3000, 40893465, 'bighead:#9aa3b8', true),
  ('jurassic', 11, 'Picklace', 192600, 'legendary', 1000, 33615415, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, '870 Coins', 870, 'common', 300000, 0, 'coins', false),
  ('midnight-holly', 1, 'Sci-Fi Santa', 4500, 'common', 62373, 18729820, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Halloween Santa Hat', 7100, 'common', 70914, 1173851, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Boo Visor', 10200, 'uncommon', 84324, 16899436, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Seeing Stars', 18700, 'uncommon', 136531, 27599954, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Hotdog Head', 35800, 'epic', 298857, 15318156, 'bighead:#9aa3b8', false),
  ('midnight-holly', 6, 'Even Eviler Jester', 106700, 'legendary', 15000, 40893465, 'bighead:#9aa3b8', true),
  ('midnight-holly', 7, 'Super Super Happy Face', 162000, 'legendary', 12000, 494291269, 'bighead:#9aa3b8', true),
  ('midnight-holly', 8, 'Korblox King', 168200, 'legendary', 10000, 52492417, 'bighead:#9aa3b8', true),
  ('midnight-holly', 9, 'Monstars Visor', 270000, 'legendary', 6000, 1086815, 'bighead:#9aa3b8', true),
  ('midnight-holly', 10, 'Valkyrie Helm', 540000, 'legendary', 3000, 1365767, 'bighead:#9aa3b8', true),
  ('midnight-holly', 11, 'Pink Queen of the Night', 1026000, 'legendary', 1000, 553971558, 'bighead:#9aa3b8', true),
  ('viking-ember', 0, 'Guardia Helm', 3100, 'common', 68681, 17449403, 'bighead:#9aa3b8', false),
  ('viking-ember', 1, 'Bluesteel Viking Helm of Infinite Pillage', 5700, 'common', 83878, 1483632, 'bighead:#9aa3b8', false),
  ('viking-ember', 2, 'Sir Burnsalot', 8500, 'common', 102145, 16158562, 'bighead:#9aa3b8', false),
  ('viking-ember', 3, 'Jack Frost', 13700, 'uncommon', 139666, 43245104, 'bighead:#9aa3b8', false),
  ('viking-ember', 4, 'Burning Otaku, the Firesouled', 24600, 'rare', 228590, 20980122, 'bighead:#9aa3b8', false),
  ('viking-ember', 5, 'Hotdog Head', 35800, 'rare', 330039, 15318156, 'bighead:#9aa3b8', false),
  ('viking-ember', 6, 'The Bluesteel Bathelm', 63000, 'legendary', 15000, 1172161, 'bighead:#9aa3b8', true),
  ('viking-ember', 7, 'Lava Reactor', 101800, 'legendary', 12000, 32858948, 'bighead:#9aa3b8', true),
  ('viking-ember', 8, 'Korblox King', 168200, 'legendary', 10000, 52492417, 'bighead:#9aa3b8', true),
  ('viking-ember', 9, 'Monstars Visor', 270000, 'legendary', 6000, 1086815, 'bighead:#9aa3b8', true),
  ('viking-ember', 10, 'Valkyrie Helm', 540000, 'legendary', 3000, 1365767, 'bighead:#9aa3b8', true),
  ('viking-ember', 11, 'Helm of the Sacred Earth', 900000, 'legendary', 1000, 22157971, 'bighead:#9aa3b8', true),
  ('nevermoor', 0, 'Sci-Fi Santa', 4500, 'common', 64681, 18729820, 'bighead:#9aa3b8', false),
  ('nevermoor', 1, 'White Witch Hat', 7300, 'common', 74037, 5207053, 'bighead:#9aa3b8', false),
  ('nevermoor', 2, 'Jack Frost', 13700, 'common', 100896, 43245104, 'bighead:#9aa3b8', false),
  ('nevermoor', 3, 'Seeing Stars', 18700, 'uncommon', 125900, 27599954, 'bighead:#9aa3b8', false),
  ('nevermoor', 4, 'Hotdog Head', 35800, 'rare', 230749, 15318156, 'bighead:#9aa3b8', false),
  ('nevermoor', 5, 'Golden Headphones', 52700, 'rare', 356737, 29051524, 'bighead:#9aa3b8', false),
  ('nevermoor', 6, 'Lava Reactor', 101800, 'legendary', 15000, 32858948, 'bighead:#9aa3b8', true),
  ('nevermoor', 7, 'The Ice Skull of Nevermoor', 180000, 'legendary', 12000, 6552254, 'bighead:#9aa3b8', true),
  ('nevermoor', 8, 'JJ5x5''s White Top Hat', 243000, 'legendary', 10000, 1073690, 'bighead:#9aa3b8', true),
  ('nevermoor', 9, 'Valkyrie Helm', 540000, 'legendary', 6000, 1365767, 'bighead:#9aa3b8', true),
  ('nevermoor', 10, 'Ice Valkyrie', 738000, 'legendary', 3000, 4390891467, 'bighead:#9aa3b8', true),
  ('nevermoor', 11, 'Hooded Frostlord', 1800000, 'legendary', 1000, 136802867, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Boo Visor', 10200, 'common', 55444, 16899436, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'Camoface', 12000, 'common', 55788, 24441888, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'Mick McCann', 21100, 'uncommon', 60793, 23264604, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Hotdog Head', 35800, 'uncommon', 92539, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'The Crown of Nachos', 44100, 'uncommon', 133447, 22547617, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Sundae Best', 74600, 'rare', 557989, 35685322, 'bighead:#9aa3b8', false),
  ('smiley', 6, 'Super Super Happy Face', 162000, 'legendary', 15000, 494291269, 'bighead:#9aa3b8', true),
  ('smiley', 7, 'Korblox King', 168200, 'legendary', 12000, 52492417, 'bighead:#9aa3b8', true),
  ('smiley', 8, 'The Ice Skull of Nevermoor', 180000, 'legendary', 10000, 6552254, 'bighead:#9aa3b8', true),
  ('smiley', 9, 'Monstars Visor', 270000, 'legendary', 6000, 1086815, 'bighead:#9aa3b8', true),
  ('smiley', 10, 'Valkyrie Helm', 540000, 'legendary', 1000, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Santa Hat', 5800, 'common', 74112, 1098277, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'Perfectly Legitimate Business Hat', 10800, 'common', 91291, 19027209, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Bucket', 18000, 'common', 116466, 1081239, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 139833, 20980122, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'The Crown of Nachos', 44100, 'uncommon', 209899, 22547617, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'Sundae Best', 74600, 'rare', 321400, 35685322, 'bighead:#9aa3b8', false),
  ('tropical-pop', 6, 'JJ5x5''s White Top Hat', 243000, 'legendary', 15000, 1073690, 'bighead:#9aa3b8', true),
  ('tropical-pop', 7, 'Monstars Visor', 270000, 'legendary', 12000, 1086815, 'bighead:#9aa3b8', true),
  ('tropical-pop', 8, 'Valkyrie Helm', 540000, 'legendary', 10000, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 9, 'Wanwood Antlers', 630000, 'legendary', 6000, 1272714, 'bighead:#9aa3b8', true),
  ('tropical-pop', 10, 'Collision Top Hat', 990000, 'legendary', 3000, 158068251, 'bighead:#9aa3b8', true),
  ('tropical-pop', 11, 'Red Crown of Ozymandias', 1980000, 'legendary', 1000, 9465511, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, '2,200 Coins', 2200, 'common', 300000, 0, 'coins', false),
  ('retro-wave', 1, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 67705, 20980122, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Hotdog Head', 35800, 'uncommon', 83512, 15318156, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'The Crown of Nachos', 44100, 'uncommon', 99681, 22547617, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'The Bluesteel Bathelm', 63000, 'rare', 151347, 1172161, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Playful Vampire', 90000, 'epic', 262755, 2409285794, 'bighead:#9aa3b8', false),
  ('retro-wave', 6, 'Monstars Visor', 270000, 'legendary', 15000, 1086815, 'bighead:#9aa3b8', true),
  ('retro-wave', 7, 'Valkyrie Helm', 540000, 'legendary', 10000, 1365767, 'bighead:#9aa3b8', true),
  ('retro-wave', 8, 'Glorious Purple Party Queen', 936000, 'legendary', 6000, 258184056, 'bighead:#9aa3b8', true),
  ('retro-wave', 9, 'Clockwork''s Headphones', 1440000, 'legendary', 3000, 1235488, 'bighead:#9aa3b8', true),
  ('retro-wave', 10, 'Retro 80s Headphones', 2520000, 'legendary', 1000, 29844011, 'bighead:#9aa3b8', true),
  ('eclipse', 0, '2,200 Coins', 2200, 'common', 250000, 0, 'coins', false),
  ('eclipse', 1, 'Black Iron Warhelm of Pwnage', 10200, 'common', 55004, 10351018, 'bighead:#9aa3b8', false),
  ('eclipse', 2, 'Seeing Stars', 18700, 'common', 55125, 27599954, 'bighead:#9aa3b8', false),
  ('eclipse', 3, 'Hotdog Head', 35800, 'uncommon', 60058, 15318156, 'bighead:#9aa3b8', false),
  ('eclipse', 4, 'Golden Headphones', 52700, 'rare', 100722, 29051524, 'bighead:#9aa3b8', false),
  ('eclipse', 5, 'Golden Chakram of the Sky Palace', 77000, 'rare', 451091, 47597760, 'bighead:#9aa3b8', false),
  ('eclipse', 6, 'JJ5x5''s White Top Hat', 243000, 'legendary', 10000, 1073690, 'bighead:#9aa3b8', true),
  ('eclipse', 7, 'Valkyrie Helm', 540000, 'legendary', 8000, 1365767, 'bighead:#9aa3b8', true),
  ('eclipse', 8, 'Silver King of the Night', 846000, 'legendary', 5000, 439945661, 'bighead:#9aa3b8', true),
  ('eclipse', 9, 'Dark Cerulean Crown of Ozymandias', 1512000, 'legendary', 3000, 13370505, 'bighead:#9aa3b8', true),
  ('eclipse', 10, 'Crown of Om Nom Nom', 3060000, 'legendary', 1500, 21070350, 'bighead:#9aa3b8', true),
  ('eclipse', 11, 'Gaze of Socom1880', 6120000, 'legendary', 500, 14671091, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, '3,300 Coins', 3300, 'common', 250000, 0, 'coins', false),
  ('shadow-beats', 1, 'Outlawed Vampumatiger Hybrid', 13800, 'common', 55255, 14817131, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'Burning Otaku, the Firesouled', 24600, 'common', 56839, 20980122, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'The Crown of Nachos', 44100, 'uncommon', 68515, 22547617, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Playful Vampire', 90000, 'rare', 209680, 2409285794, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Even Eviler Jester', 106700, 'rare', 331711, 40893465, 'bighead:#9aa3b8', false),
  ('shadow-beats', 6, 'Monstars Visor', 270000, 'legendary', 10000, 1086815, 'bighead:#9aa3b8', true),
  ('shadow-beats', 7, 'Silver King of the Night', 846000, 'legendary', 8000, 439945661, 'bighead:#9aa3b8', true),
  ('shadow-beats', 8, 'Pink Queen of the Night', 1026000, 'legendary', 5000, 553971558, 'bighead:#9aa3b8', true),
  ('shadow-beats', 9, 'Vaiobot''s Moneylicious Tie', 2250000, 'legendary', 3000, 30371876, 'bighead:#9aa3b8', true),
  ('shadow-beats', 10, 'Sword Cane', 4320000, 'legendary', 1500, 25740034, 'bighead:#9aa3b8', true),
  ('shadow-beats', 11, 'Black Iron King of the Night', 10800000, 'legendary', 500, 439946249, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'Jack Frost', 13700, 'common', 67978, 43245104, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'Burning Otaku, the Firesouled', 24600, 'common', 81127, 20980122, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'The Crown of Nachos', 44100, 'common', 107496, 22547617, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Sundae Best', 74600, 'uncommon', 153409, 35685322, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Even Eviler Jester', 106700, 'uncommon', 205949, 40893465, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'The Ice Skull of Nevermoor', 180000, 'rare', 337041, 6552254, 'bighead:#9aa3b8', false),
  ('arctic-moss', 6, 'Wanwood Antlers', 630000, 'legendary', 15000, 1272714, 'bighead:#9aa3b8', true),
  ('arctic-moss', 7, 'Ice Valkyrie', 738000, 'legendary', 12000, 4390891467, 'bighead:#9aa3b8', true),
  ('arctic-moss', 8, 'Green Ice Crown', 954000, 'legendary', 10000, 193696233, 'bighead:#9aa3b8', true),
  ('arctic-moss', 9, 'Helm of the Great Tree', 1350000, 'legendary', 6000, 9910420, 'bighead:#9aa3b8', true),
  ('arctic-moss', 10, 'Green Bow Tie', 2700000, 'legendary', 3000, 16598513, 'bighead:#9aa3b8', true),
  ('arctic-moss', 11, 'The Ice Crown', 7200000, 'legendary', 1000, 1323384, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'Seeing Stars', 18700, 'common', 56235, 27599954, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Hotdog Head', 35800, 'common', 60370, 15318156, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'Golden Headphones', 52700, 'common', 67883, 29051524, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Golden Chakram of the Sky Palace', 77000, 'uncommon', 85389, 47597760, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Super Super Happy Face', 162000, 'rare', 218593, 494291269, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'JJ5x5''s White Top Hat', 243000, 'rare', 464529, 1073690, 'bighead:#9aa3b8', false),
  ('sunbeam', 6, 'Valkyrie Helm', 540000, 'legendary', 15000, 1365767, 'bighead:#9aa3b8', true),
  ('sunbeam', 7, 'Ice Valkyrie', 738000, 'legendary', 12000, 4390891467, 'bighead:#9aa3b8', true),
  ('sunbeam', 8, 'Helm of the Sacred Earth', 900000, 'legendary', 10000, 22157971, 'bighead:#9aa3b8', true),
  ('sunbeam', 9, 'Goldlika: Hero', 936000, 'legendary', 6000, 323419455, 'bighead:#9aa3b8', true),
  ('sunbeam', 10, 'Headdress of Aken-Aten, the Sun King', 1080000, 'legendary', 3000, 18482398, 'bighead:#9aa3b8', true),
  ('sunbeam', 11, 'GoldLika: Troll', 1530000, 'legendary', 1000, 398674241, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, '9,300 Coins', 9300, 'common', 180000, 0, 'coins', false),
  ('neon-pop', 1, 'Golden Chakram of the Sky Palace', 77000, 'common', 65946, 47597760, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Even Eviler Jester', 106700, 'uncommon', 78723, 40893465, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'The Ice Skull of Nevermoor', 180000, 'uncommon', 136970, 6552254, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 221986, 1073690, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'Monstars Visor', 270000, 'rare', 269375, 1086815, 'bighead:#9aa3b8', false),
  ('neon-pop', 6, 'Neon Purple Crazy Crown', 1116000, 'legendary', 15000, 376805769, 'bighead:#9aa3b8', true),
  ('neon-pop', 7, 'Crazy Glasses', 1350000, 'legendary', 12000, 16646369, 'bighead:#9aa3b8', true),
  ('neon-pop', 8, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 10000, 188888052, 'bighead:#9aa3b8', true),
  ('neon-pop', 9, 'Neon Green Crazy Crown', 2430000, 'legendary', 6000, 321346616, 'bighead:#9aa3b8', true),
  ('neon-pop', 10, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 3000, 315549204, 'bighead:#9aa3b8', true),
  ('neon-pop', 11, '): Red Grind', 11700000, 'legendary', 1000, 20573086, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, '9,600 Coins', 9600, 'common', 250000, 0, 'coins', false),
  ('crystal-beats', 1, 'Super Super Happy Face', 162000, 'uncommon', 55007, 494291269, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'The Ice Skull of Nevermoor', 180000, 'uncommon', 55065, 6552254, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'Picklace', 192600, 'uncommon', 55280, 33615415, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 96842, 1073690, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'Monstars Visor', 270000, 'rare', 459806, 1086815, 'bighead:#9aa3b8', false),
  ('crystal-beats', 6, 'Green Ice Crown', 954000, 'legendary', 10000, 193696233, 'bighead:#9aa3b8', true),
  ('crystal-beats', 7, 'Retro 80s Headphones', 2520000, 'legendary', 8000, 29844011, 'bighead:#9aa3b8', true),
  ('crystal-beats', 8, 'Yellow Glowing Eyes', 3240000, 'legendary', 5000, 416846000, 'bighead:#9aa3b8', true),
  ('crystal-beats', 9, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 3000, 315549204, 'bighead:#9aa3b8', true),
  ('crystal-beats', 10, 'WC Ultimates: Aquamarine Attitude', 17100000, 'legendary', 1500, 323417812, 'bighead:#9aa3b8', true),
  ('crystal-beats', 11, 'Eerie Pumpkin Head', 36000000, 'legendary', 500, 1158416, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Hotdog Head', 35800, 'common', 94453, 15318156, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Pin Head', 56100, 'common', 107231, 25880554, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'Lava Reactor', 101800, 'common', 130782, 32858948, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Super Super Happy Face', 162000, 'uncommon', 156296, 494291269, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Monstars Visor', 270000, 'uncommon', 194366, 1086815, 'bighead:#9aa3b8', false),
  ('lime-grin', 5, 'Valkyrie Helm', 540000, 'epic', 269871, 1365767, 'bighead:#9aa3b8', false),
  ('lime-grin', 6, 'Clockwork''s Headphones', 1440000, 'legendary', 15000, 1235488, 'bighead:#9aa3b8', true),
  ('lime-grin', 7, 'GoldLika: Troll', 1530000, 'legendary', 12000, 398674241, 'bighead:#9aa3b8', true),
  ('lime-grin', 8, 'Neon Green Crazy Crown', 2430000, 'legendary', 10000, 321346616, 'bighead:#9aa3b8', true),
  ('lime-grin', 9, 'Yellow Glowing Eyes', 3240000, 'legendary', 6000, 416846000, 'bighead:#9aa3b8', true),
  ('lime-grin', 10, 'Gaze of Socom1880', 6120000, 'legendary', 3000, 14671091, 'bighead:#9aa3b8', true),
  ('lime-grin', 11, '): Red Grind', 11700000, 'legendary', 1000, 20573086, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'Golden Headphones', 52700, 'common', 59743, 29051524, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'Golden Chakram of the Sky Palace', 77000, 'common', 64001, 47597760, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'Even Eviler Jester', 106700, 'common', 70621, 40893465, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'The Ice Skull of Nevermoor', 180000, 'uncommon', 92797, 6552254, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'Valkyrie Helm', 540000, 'rare', 296926, 1365767, 'bighead:#9aa3b8', false),
  ('mistletoe', 5, 'Wanwood Antlers', 630000, 'rare', 368912, 1272714, 'bighead:#9aa3b8', false),
  ('mistletoe', 6, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 15000, 149594212, 'bighead:#9aa3b8', true),
  ('mistletoe', 7, 'Immortal Sword: Endless Ice Slasher', 1800000, 'legendary', 12000, 568920951, 'bighead:#9aa3b8', true),
  ('mistletoe', 8, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 10000, 188888052, 'bighead:#9aa3b8', true),
  ('mistletoe', 9, 'Neon Green Crazy Crown', 2430000, 'legendary', 6000, 321346616, 'bighead:#9aa3b8', true),
  ('mistletoe', 10, 'Green Bow Tie', 2700000, 'legendary', 3000, 16598513, 'bighead:#9aa3b8', true),
  ('mistletoe', 11, 'Sparkle Time Fedora', 4500000, 'legendary', 1000, 1285307, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, '16,000 Coins', 16000, 'common', 300000, 0, 'coins', false),
  ('winter-crown', 1, 'The Crown of Nachos', 44100, 'common', 56583, 22547617, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Playful Vampire', 90000, 'common', 60994, 2409285794, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'Korblox King', 168200, 'uncommon', 74264, 52492417, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Monstars Visor', 270000, 'uncommon', 101606, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Ice Valkyrie', 738000, 'epic', 359554, 4390891467, 'bighead:#9aa3b8', false),
  ('winter-crown', 6, 'Red Crown of Ozymandias', 1980000, 'legendary', 15000, 9465511, 'bighead:#9aa3b8', true),
  ('winter-crown', 7, 'Neon Green Crazy Crown', 2430000, 'legendary', 12000, 321346616, 'bighead:#9aa3b8', true),
  ('winter-crown', 8, 'Crown of Om Nom Nom', 3060000, 'legendary', 10000, 21070350, 'bighead:#9aa3b8', true),
  ('winter-crown', 9, 'The Void Star', 5580000, 'legendary', 6000, 1125510, 'bighead:#9aa3b8', true),
  ('winter-crown', 10, 'Black Iron King of the Night', 10800000, 'legendary', 3000, 439946249, 'bighead:#9aa3b8', true),
  ('winter-crown', 11, 'Darkheart', 21600000, 'legendary', 1000, 16895215, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'Playful Vampire', 90000, 'common', 78707, 2409285794, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'Super Super Happy Face', 162000, 'common', 93348, 494291269, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'JJ5x5''s White Top Hat', 243000, 'common', 108435, 1073690, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Wanwood Antlers', 630000, 'uncommon', 171507, 1272714, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Pink Queen of the Night', 1026000, 'rare', 228644, 553971558, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'Helm of the Great Tree', 1350000, 'epic', 272361, 9910420, 'bighead:#9aa3b8', false),
  ('violet-beats', 6, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 15000, 188004500, 'bighead:#9aa3b8', true),
  ('violet-beats', 7, 'Crown of the Undead Hoard', 2610000, 'legendary', 12000, 31046644, 'bighead:#9aa3b8', true),
  ('violet-beats', 8, 'Chrononoctis: The Ominous Helm', 2790000, 'legendary', 10000, 161211371, 'bighead:#9aa3b8', true),
  ('violet-beats', 9, 'CW Ultimate: Rose Quartz Rebellion', 3600000, 'legendary', 6000, 228449574, 'bighead:#9aa3b8', true),
  ('violet-beats', 10, 'Steampunk Aetherspectacles', 4860000, 'legendary', 3000, 12908119, 'bighead:#9aa3b8', true),
  ('violet-beats', 11, 'Dominus Rex', 7920000, 'legendary', 1000, 250395631, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'Playful Vampire', 90000, 'common', 151634, 2409285794, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'The Ice Skull of Nevermoor', 180000, 'common', 154898, 6552254, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'JJ5x5''s White Top Hat', 243000, 'common', 156345, 1073690, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Ice Valkyrie', 738000, 'rare', 161887, 4390891467, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Green Ice Crown', 954000, 'rare', 163210, 193696233, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'Helm of the Great Tree', 1350000, 'epic', 165026, 9910420, 'bighead:#9aa3b8', false),
  ('glacier', 6, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 15000, 74891470, 'bighead:#9aa3b8', true),
  ('glacier', 7, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 12000, 215718515, 'bighead:#9aa3b8', true),
  ('glacier', 8, 'Steampunk Aetherspectacles', 4860000, 'legendary', 10000, 12908119, 'bighead:#9aa3b8', true),
  ('glacier', 9, 'The Ice Crown', 7200000, 'legendary', 6000, 1323384, 'bighead:#9aa3b8', true),
  ('glacier', 10, 'The Wanwood Crown', 14400000, 'legendary', 3000, 9910070, 'bighead:#9aa3b8', true),
  ('glacier', 11, 'Eerie Pumpkin Head', 36000000, 'legendary', 1000, 1158416, 'bighead:#9aa3b8', true),
  ('evergreen', 0, '30,000 Coins', 30000, 'common', 300000, 0, 'coins', false),
  ('evergreen', 1, 'Super Super Happy Face', 162000, 'common', 83727, 494291269, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'JJ5x5''s White Top Hat', 243000, 'common', 93446, 1073690, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Wanwood Antlers', 630000, 'uncommon', 131243, 1272714, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Green Ice Crown', 954000, 'rare', 157734, 193696233, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Helm of the Great Tree', 1350000, 'epic', 186850, 9910420, 'bighead:#9aa3b8', false),
  ('evergreen', 6, 'Green Glowing Eyes', 3780000, 'legendary', 15000, 398676450, 'bighead:#9aa3b8', true),
  ('evergreen', 7, 'CW Ultimate: Emerald Entropy', 4320000, 'legendary', 12000, 271015154, 'bighead:#9aa3b8', true),
  ('evergreen', 8, 'Gaze of Socom1880', 6120000, 'legendary', 10000, 14671091, 'bighead:#9aa3b8', true),
  ('evergreen', 9, 'Red Glowing Eyes', 8280000, 'legendary', 6000, 180660043, 'bighead:#9aa3b8', true),
  ('evergreen', 10, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 3000, 489196035, 'bighead:#9aa3b8', true),
  ('evergreen', 11, 'Domino Crown', 43200000, 'legendary', 1000, 1031429, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 67276, 6552254, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'JJ5x5''s White Top Hat', 243000, 'common', 72695, 1073690, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'Ice Valkyrie', 738000, 'uncommon', 123491, 4390891467, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Green Ice Crown', 954000, 'uncommon', 148641, 193696233, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'Hooded Frostlord', 1800000, 'rare', 257954, 136802867, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Red Crown of Ozymandias', 1980000, 'epic', 282944, 9465511, 'bighead:#9aa3b8', false),
  ('fire-ice', 6, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 15000, 215718515, 'bighead:#9aa3b8', true),
  ('fire-ice', 7, ':( Front Stand', 4050000, 'legendary', 12000, 321346550, 'bighead:#9aa3b8', true),
  ('fire-ice', 8, 'Sparkle Time Fedora', 4500000, 'legendary', 10000, 1285307, 'bighead:#9aa3b8', true),
  ('fire-ice', 9, 'The Ice Crown', 7200000, 'legendary', 6000, 1323384, 'bighead:#9aa3b8', true),
  ('fire-ice', 10, 'Red Glowing Eyes', 8280000, 'legendary', 3000, 180660043, 'bighead:#9aa3b8', true),
  ('fire-ice', 11, '): Red Grind', 11700000, 'legendary', 1000, 20573086, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'The Ice Skull of Nevermoor', 180000, 'common', 124095, 6552254, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'JJ5x5''s White Top Hat', 243000, 'common', 130020, 1073690, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Ice Valkyrie', 738000, 'uncommon', 156732, 4390891467, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'Green Ice Crown', 954000, 'uncommon', 164150, 193696233, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'Hooded Frostlord', 1800000, 'rare', 184904, 136802867, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Vaiobot''s Moneylicious Tie', 2250000, 'epic', 193100, 30371876, 'bighead:#9aa3b8', false),
  ('black-ice', 6, 'Azurewrath, Lord of the Void', 3420000, 'legendary', 15000, 17109706, 'bighead:#9aa3b8', true),
  ('black-ice', 7, 'The Ice Crown', 7200000, 'legendary', 12000, 1323384, 'bighead:#9aa3b8', true),
  ('black-ice', 8, 'Black Iron King of the Night', 10800000, 'legendary', 10000, 439946249, 'bighead:#9aa3b8', true),
  ('black-ice', 9, 'The Crown of Roses', 13500000, 'legendary', 6000, 17449820, 'bighead:#9aa3b8', true),
  ('black-ice', 10, 'Darkheart', 21600000, 'legendary', 3000, 16895215, 'bighead:#9aa3b8', true),
  ('black-ice', 11, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1000, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 0, '84,000 Coins', 84000, 'common', 250000, 0, 'coins', false),
  ('amethyst', 1, 'Monstars Visor', 270000, 'common', 55001, 1086815, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'Valkyrie Helm', 540000, 'common', 55060, 1365767, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'Glorious Purple Party Queen', 936000, 'uncommon', 56178, 258184056, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Fancy St. Patrick''s Fedora', 1350000, 'uncommon', 63568, 149594212, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'Chrononoctis: The Ominous Helm', 2790000, 'rare', 492193, 161211371, 'bighead:#9aa3b8', false),
  ('amethyst', 6, 'Countess of the Federation', 9000000, 'legendary', 10000, 188003914, 'bighead:#9aa3b8', true),
  ('amethyst', 7, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 8000, 215751161, 'bighead:#9aa3b8', true),
  ('amethyst', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 5000, 63043890, 'bighead:#9aa3b8', true),
  ('amethyst', 9, 'Black Sparkle Time Fedora', 45000000, 'legendary', 3000, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 10, 'Dominus Astra', 108000000, 'legendary', 1500, 162067148, 'bighead:#9aa3b8', true),
  ('amethyst', 11, 'Dominus Empyreus', 198000000, 'legendary', 500, 21070012, 'bighead:#9aa3b8', true),
  ('jade', 0, '150,000 Coins', 150000, 'common', 300000, 0, 'coins', false),
  ('jade', 1, 'Eyes of Emeraldwrath', 1260000, 'common', 55675, 209994352, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Hooded Frostlord', 1800000, 'uncommon', 57907, 136802867, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Green Bow Tie', 2700000, 'uncommon', 70289, 16598513, 'bighead:#9aa3b8', false),
  ('jade', 4, 'Green Glowing Eyes', 3780000, 'rare', 115612, 398676450, 'bighead:#9aa3b8', false),
  ('jade', 5, 'The Void Star', 5580000, 'rare', 353517, 1125510, 'bighead:#9aa3b8', false),
  ('jade', 6, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 15000, 147180077, 'bighead:#9aa3b8', true),
  ('jade', 7, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12000, 493476042, 'bighead:#9aa3b8', true),
  ('jade', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 10000, 63043890, 'bighead:#9aa3b8', true),
  ('jade', 9, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6000, 259423244, 'bighead:#9aa3b8', true),
  ('jade', 10, 'Dominus Astra', 108000000, 'legendary', 3000, 162067148, 'bighead:#9aa3b8', true),
  ('jade', 11, 'Dominus Empyreus', 198000000, 'legendary', 1000, 21070012, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Valkyrie Helm', 540000, 'common', 55912, 1365767, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'Green Ice Crown', 954000, 'common', 58532, 193696233, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Admiral of the Royal Skyfleet', 1350000, 'common', 63070, 15731113, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'Eyes of Azurewrath', 2520000, 'uncommon', 90634, 17999992, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Sparkle Time Fedora', 4500000, 'uncommon', 196595, 1285307, 'bighead:#9aa3b8', false),
  ('sapphire', 5, 'The Ice Crown', 7200000, 'rare', 488257, 1323384, 'bighead:#9aa3b8', false),
  ('sapphire', 6, '): Red Grind', 11700000, 'legendary', 15000, 20573086, 'bighead:#9aa3b8', true),
  ('sapphire', 7, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12000, 493476042, 'bighead:#9aa3b8', true),
  ('sapphire', 8, '): Euro 180', 22500000, 'legendary', 10000, 23705521, 'bighead:#9aa3b8', true),
  ('sapphire', 9, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 6000, 63043890, 'bighead:#9aa3b8', true),
  ('sapphire', 10, 'Domino Crown', 43200000, 'legendary', 3000, 1031429, 'bighead:#9aa3b8', true),
  ('sapphire', 11, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1000, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'Wanwood Antlers', 630000, 'common', 61195, 1272714, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Neon Purple Crazy Crown', 1116000, 'common', 70370, 376805769, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'Red Crown of Ozymandias', 1980000, 'common', 93225, 9465511, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Crown of Om Nom Nom', 3060000, 'uncommon', 131341, 21070350, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'Sparkle Time Fedora', 4500000, 'uncommon', 195899, 1285307, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'Dominus Rex', 7920000, 'rare', 400969, 250395631, 'bighead:#9aa3b8', false),
  ('sunset-remix', 6, 'The Wanwood Crown', 14400000, 'legendary', 15000, 9910070, 'bighead:#9aa3b8', true),
  ('sunset-remix', 7, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12000, 493476042, 'bighead:#9aa3b8', true),
  ('sunset-remix', 8, 'Domino Crown', 43200000, 'legendary', 10000, 1031429, 'bighead:#9aa3b8', true),
  ('sunset-remix', 9, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6000, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 10, 'Dominus Astra', 108000000, 'legendary', 3000, 162067148, 'bighead:#9aa3b8', true),
  ('sunset-remix', 11, 'Dominus Empyreus', 198000000, 'legendary', 1000, 21070012, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'SFOTH IV Crown of Fire', 2520000, 'common', 59025, 173783297, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'Tixvalk', 4140000, 'common', 64556, 382881237, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, 'The Ice Crown', 7200000, 'common', 80050, 1323384, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'Dominus Aureus', 10800000, 'uncommon', 105753, 138932314, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Teal Sparkle Time Fedora', 18000000, 'uncommon', 178538, 147180077, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Purple Sparkle Time Fedora', 36000000, 'epic', 468079, 63043890, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 6, 'Black Sparkle Time Fedora', 45000000, 'legendary', 15000, 259423244, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 7, 'Dominus Astra', 108000000, 'legendary', 12000, 162067148, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 8, 'Dominus Infernus', 126000000, 'legendary', 10000, 31101391, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 9, 'Dominus Frigidus', 162000000, 'legendary', 6000, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 10, 'Dominus Empyreus', 198000000, 'legendary', 1000, 21070012, 'bighead:#9aa3b8', true);

-- Leaderboard: admins can hide a player (their wagers stop counting and they vanish from the board)
alter table public.profiles add column if not exists lb_hidden boolean not null default false;

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
  if coalesce((select lb_hidden from public.profiles where id = p_uid), false) then return; end if;
  insert into public.weekly_wagers (week_start, user_id, wagered, updated_at)
  values (public.lb_week(), p_uid, p_amount, now())
  on conflict (week_start, user_id) do update
    set wagered = public.weekly_wagers.wagered + excluded.wagered, updated_at = now();
end $$;


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
        from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)
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


create or replace function public.get_leaderboard()
returns json language plpgsql volatile security definer set search_path = public as $$
declare w date := public.lb_week(); prizes bigint[] := public.lb_prizes(); v_me json; v_top json; v_last json;
begin
  perform public.lb_settle();
  select coalesce(json_agg(t order by t.rank), '[]') into v_top from (
    select row_number() over (order by ww.wagered desc, ww.updated_at) as rank, ww.user_id, p.username, ww.wagered,
           public.level_of(p.wagered) as level
      from public.weekly_wagers ww join public.profiles p on p.id = ww.user_id
     where ww.week_start = w and ww.wagered > 0 and not p.lb_hidden
     order by ww.wagered desc, ww.updated_at limit 50) t;
  if auth.uid() is not null then
    select json_build_object('rank', t.rank, 'wagered', coalesce(t.wagered, 0)) into v_me from (
      select rank, wagered from (
        select user_id, wagered, row_number() over (order by wagered desc, updated_at) as rank
          from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)) x
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


create or replace function public.admin_set_lb_hidden(p_user uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.profiles set lb_hidden = p_hidden where id = p_user;
end $$;

create or replace function public.admin_find(p_q text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(json_agg(t order by t.wagered desc), '[]') from (
    select p.id, p.username, u.email, p.coins, p.wagered, p.created_at, p.is_admin, p.lb_hidden
      from public.profiles p left join auth.users u on u.id = p.id
     where p_q is null or p_q = '' or p.username ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
     order by p.wagered desc limit 25) t);
end $$;

-- Who may call what
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text), public.get_profile(uuid), public.get_leaderboard() to anon, authenticated;
grant execute on function
  public.my_profile(), public.set_username(text), public.claim_faucet(), public.open_case(text),
  public.mines_start(bigint, int, int), public.mines_reveal(bigint, int), public.mines_cashout(bigint), public.mines_resume(),
  public.battle_create(text, text[], boolean, boolean, boolean), public.battle_join(uuid, int, boolean), public.battle_add_bots(uuid, int), public.battle_cancel(uuid),
  public.send_chat(text), public.tip_user(uuid, bigint), public.upgrade(bigint, bigint, boolean), public.claim_pack(int),
  public.bj_start(bigint), public.bj_act(bigint, text), public.bj_resume(),
  public.admin_stats(), public.admin_find(text), public.admin_coins(uuid, bigint), public.admin_set_admin(uuid, boolean), public.admin_delete_chat(bigint), public.admin_set_lb_hidden(uuid, boolean)
  to authenticated;

-- =====================================================================
-- Included: update 11 (harsh case odds, items only)
-- =====================================================================

insert into public.cases (id, name, sort, price, image, active) values
  ('peppermint', 'Peppermint', 100, 1000, 'assets/cases/peppermint.webp', true),
  ('crystal-egg', 'Crystal Egg', 101, 1100, 'assets/cases/crystal-egg.webp', true),
  ('faberge', 'Fabergé', 102, 1000, 'assets/cases/faberge.webp', true),
  ('zombie-horde', 'Zombie Horde', 103, 1200, 'assets/cases/zombie-horde.webp', true),
  ('haunted-patch', 'Haunted Patch', 104, 1500, 'assets/cases/haunted-patch.webp', true),
  ('fiesta', 'Fiesta', 105, 2000, 'assets/cases/fiesta.webp', true),
  ('overgrown', 'Overgrown', 106, 2500, 'assets/cases/overgrown.webp', true),
  ('dragon-hatch', 'Dragon Hatch', 107, 3000, 'assets/cases/dragon-hatch.webp', true),
  ('orbit', 'Orbit', 108, 3900, 'assets/cases/orbit.webp', true),
  ('martian', 'Martian', 109, 5000, 'assets/cases/martian.webp', true),
  ('blue-grin', 'Blue Grin', 110, 5200, 'assets/cases/blue-grin.webp', true),
  ('gearhead', 'Gearhead', 111, 6500, 'assets/cases/gearhead.webp', true),
  ('gilded-night', 'Gilded Night', 112, 6600, 'assets/cases/gilded-night.webp', true),
  ('spooky-beats', 'Spooky Beats', 113, 8000, 'assets/cases/spooky-beats.webp', true),
  ('atlantis', 'Atlantis', 114, 9100, 'assets/cases/atlantis.webp', true),
  ('ember', 'Ember', 115, 9800, 'assets/cases/ember.webp', true),
  ('topaz', 'Topaz', 116, 10000, 'assets/cases/topaz.webp', true),
  ('tide-blade', 'Tide Blade', 117, 12000, 'assets/cases/tide-blade.webp', true),
  ('brass-samurai', 'Brass Samurai', 118, 15000, 'assets/cases/brass-samurai.webp', true),
  ('bubblegum-grin', 'Bubblegum Grin', 119, 16000, 'assets/cases/bubblegum-grin.webp', true),
  ('shogun', 'Shogun', 120, 20000, 'assets/cases/shogun.webp', true),
  ('golden-snow', 'Golden Snow', 121, 21000, 'assets/cases/golden-snow.webp', true),
  ('frostbite', 'Frostbite', 122, 22000, 'assets/cases/frostbite.webp', true),
  ('pop-art', 'Pop Art', 123, 23000, 'assets/cases/pop-art.webp', true),
  ('jurassic', 'Jurassic', 124, 25000, 'assets/cases/jurassic.webp', true),
  ('midnight-holly', 'Midnight Holly', 125, 29000, 'assets/cases/midnight-holly.webp', true),
  ('viking-ember', 'Viking Ember', 126, 34000, 'assets/cases/viking-ember.webp', true),
  ('nevermoor', 'Nevermoor', 127, 50000, 'assets/cases/nevermoor.webp', true),
  ('smiley', 'Smiley', 128, 65000, 'assets/cases/smiley.webp', true),
  ('tropical-pop', 'Tropical Pop', 129, 68000, 'assets/cases/tropical-pop.webp', true),
  ('retro-wave', 'Retro Wave', 130, 72000, 'assets/cases/retro-wave.webp', true),
  ('eclipse', 'Eclipse', 131, 75000, 'assets/cases/eclipse.webp', true),
  ('shadow-beats', 'Shadow Beats', 132, 110000, 'assets/cases/shadow-beats.webp', true),
  ('arctic-moss', 'Arctic Moss', 133, 180000, 'assets/cases/arctic-moss.webp', true),
  ('sunbeam', 'Sunbeam', 134, 220000, 'assets/cases/sunbeam.webp', true),
  ('neon-pop', 'Neon Pop', 135, 310000, 'assets/cases/neon-pop.webp', true),
  ('crystal-beats', 'Crystal Beats', 136, 320000, 'assets/cases/crystal-beats.webp', true),
  ('lime-grin', 'Lime Grin', 137, 400000, 'assets/cases/lime-grin.webp', true),
  ('mistletoe', 'Mistletoe', 138, 540000, 'assets/cases/mistletoe.webp', true),
  ('winter-crown', 'Winter Crown', 139, 550000, 'assets/cases/winter-crown.webp', true),
  ('violet-beats', 'Violet Beats', 140, 1000000, 'assets/cases/violet-beats.webp', true),
  ('glacier', 'Glacier', 141, 1000000, 'assets/cases/glacier.webp', true),
  ('evergreen', 'Evergreen', 142, 1000000, 'assets/cases/evergreen.webp', true),
  ('fire-ice', 'Fire Ice', 143, 1600000, 'assets/cases/fire-ice.webp', true),
  ('black-ice', 'Black Ice', 144, 1700000, 'assets/cases/black-ice.webp', true),
  ('amethyst', 'Amethyst', 145, 2800000, 'assets/cases/amethyst.webp', true),
  ('jade', 'Jade', 146, 5000000, 'assets/cases/jade.webp', true),
  ('sapphire', 'Sapphire', 147, 6500000, 'assets/cases/sapphire.webp', true),
  ('sunset-remix', 'Sunset Remix', 148, 7600000, 'assets/cases/sunset-remix.webp', true),
  ('ultimate-grin', 'Ultimate Grin', 149, 28000000, 'assets/cases/ultimate-grin.webp', true)
on conflict (id) do update set name = excluded.name, sort = excluded.sort, price = excluded.price, image = excluded.image, active = true;

delete from public.case_items where case_id in ('peppermint','crystal-egg','faberge','zombie-horde','haunted-patch','fiesta','overgrown','dragon-hatch','orbit','martian','blue-grin','gearhead','gilded-night','spooky-beats','atlantis','ember','topaz','tide-blade','brass-samurai','bubblegum-grin','shogun','golden-snow','frostbite','pop-art','jurassic','midnight-holly','viking-ember','nevermoor','smiley','tropical-pop','retro-wave','eclipse','shadow-beats','arctic-moss','sunbeam','neon-pop','crystal-beats','lime-grin','mistletoe','winter-crown','violet-beats','glacier','evergreen','fire-ice','black-ice','amethyst','jade','sapphire','sunset-remix','ultimate-grin');

insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('peppermint', 0, 'POW! To the Moon! Egg', 400, 'rare', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('peppermint', 1, 'Specular Egg of Red, No Blue', 400, 'rare', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('peppermint', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'rare', 95000, 24826811, 'bighead:#9aa3b8', false),
  ('peppermint', 3, 'Unassuming Egg of Shyness', 400, 'rare', 95000, 24826840, 'bighead:#9aa3b8', false),
  ('peppermint', 4, 'Chrome Egg of Speeding Bullet', 500, 'rare', 95000, 24826640, 'bighead:#9aa3b8', false),
  ('peppermint', 5, 'Snowflake Winter Cap', 1400, 'legendary', 15957, 42846005, 'bighead:#9aa3b8', true),
  ('peppermint', 6, 'Spring into Christmas', 1800, 'legendary', 12766, 67995955, 'bighead:#9aa3b8', true),
  ('peppermint', 7, 'Blue Winter Cap', 3500, 'legendary', 10638, 1309918, 'bighead:#9aa3b8', true),
  ('peppermint', 8, 'Sci-Fi Santa', 4500, 'legendary', 6383, 18729820, 'bighead:#9aa3b8', true),
  ('peppermint', 9, '2010 Party Cap', 7100, 'legendary', 3191, 20044751, 'bighead:#9aa3b8', true),
  ('peppermint', 10, 'Bucket', 18000, 'legendary', 1064, 1081239, 'bighead:#9aa3b8', true),
  ('crystal-egg', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('crystal-egg', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 270000, 24826800, 'bighead:#9aa3b8', false),
  ('crystal-egg', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 90000, 24826811, 'bighead:#9aa3b8', false),
  ('crystal-egg', 3, 'Unassuming Egg of Shyness', 400, 'uncommon', 90000, 24826840, 'bighead:#9aa3b8', false),
  ('crystal-egg', 4, 'Chrome Egg of Speeding Bullet', 500, 'rare', 90000, 24826640, 'bighead:#9aa3b8', false),
  ('crystal-egg', 5, 'Stationary Egg of Boring', 1200, 'legendary', 31915, 1530795, 'bighead:#9aa3b8', true),
  ('crystal-egg', 6, 'Starry Egg of the Wild Ride', 1500, 'legendary', 25532, 31151864, 'bighead:#9aa3b8', true),
  ('crystal-egg', 7, 'Ethereal Ghost Egg', 2000, 'legendary', 21277, 76692331, 'bighead:#9aa3b8', true),
  ('crystal-egg', 8, 'Puzzling Egg of Enigma', 2600, 'legendary', 12766, 1532386, 'bighead:#9aa3b8', true),
  ('crystal-egg', 9, 'Green Fabergé Egg', 3300, 'legendary', 6383, 24832637, 'bighead:#9aa3b8', true),
  ('crystal-egg', 10, 'Invisible Egg of Shadow', 4900, 'legendary', 2128, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('faberge', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('faberge', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 99000, 24826811, 'bighead:#9aa3b8', false),
  ('faberge', 3, 'Chrome Egg of Speeding Bullet', 500, 'uncommon', 99000, 24826640, 'bighead:#9aa3b8', false),
  ('faberge', 4, 'Guardia in Exile', 800, 'rare', 99000, 18174901, 'bighead:#9aa3b8', false),
  ('faberge', 5, 'Fried Egg Eye Patch', 3100, 'legendary', 3571, 63647492, 'bighead:#9aa3b8', true),
  ('faberge', 6, 'Invisible Egg of Shadow', 4900, 'legendary', 2857, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 7, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 1786, 10351018, 'bighead:#9aa3b8', true),
  ('faberge', 8, 'Mick McCann', 21100, 'legendary', 1071, 23264604, 'bighead:#9aa3b8', true),
  ('faberge', 9, 'Viridian Hood', 41200, 'legendary', 536, 16954107, 'bighead:#9aa3b8', true),
  ('faberge', 10, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 179, 47597760, 'bighead:#9aa3b8', true),
  ('zombie-horde', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('zombie-horde', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('zombie-horde', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 99000, 24826811, 'bighead:#9aa3b8', false),
  ('zombie-horde', 3, 'Rusty Egg of Magnetism', 600, 'uncommon', 99000, 24826787, 'bighead:#9aa3b8', false),
  ('zombie-horde', 4, 'Racing Helmet', 900, 'rare', 99000, 6379764, 'bighead:#9aa3b8', false),
  ('zombie-horde', 5, 'Halloween Harbinger', 3300, 'legendary', 3571, 15727771, 'bighead:#9aa3b8', true),
  ('zombie-horde', 6, 'Halloween Santa Hat', 7100, 'legendary', 2857, 1173851, 'bighead:#9aa3b8', true),
  ('zombie-horde', 7, 'Camoface', 12000, 'legendary', 1786, 24441888, 'bighead:#9aa3b8', true),
  ('zombie-horde', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 1071, 20980122, 'bighead:#9aa3b8', true),
  ('zombie-horde', 9, 'The Crown of Nachos', 44100, 'legendary', 536, 22547617, 'bighead:#9aa3b8', true),
  ('zombie-horde', 10, 'Lava Reactor', 101800, 'legendary', 179, 32858948, 'bighead:#9aa3b8', true),
  ('haunted-patch', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('haunted-patch', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('haunted-patch', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 95000, 24826811, 'bighead:#9aa3b8', false),
  ('haunted-patch', 3, 'Guardia in Exile', 800, 'uncommon', 95000, 18174901, 'bighead:#9aa3b8', false),
  ('haunted-patch', 4, 'Stationary Egg of Boring', 1200, 'rare', 95000, 1530795, 'bighead:#9aa3b8', false),
  ('haunted-patch', 5, 'Halloween Harbinger', 3300, 'legendary', 15957, 15727771, 'bighead:#9aa3b8', true),
  ('haunted-patch', 6, 'Sci-Fi Santa', 4500, 'legendary', 12766, 18729820, 'bighead:#9aa3b8', true),
  ('haunted-patch', 7, 'Halloween Santa Hat', 7100, 'legendary', 10638, 1173851, 'bighead:#9aa3b8', true),
  ('haunted-patch', 8, 'Camoface', 12000, 'legendary', 6383, 24441888, 'bighead:#9aa3b8', true),
  ('haunted-patch', 9, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 3191, 1285300, 'bighead:#9aa3b8', true),
  ('haunted-patch', 10, 'The Crown of Nachos', 44100, 'legendary', 1064, 22547617, 'bighead:#9aa3b8', true),
  ('fiesta', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('fiesta', 1, 'Specular Egg of Red, No Blue', 400, 'common', 270000, 24826800, 'bighead:#9aa3b8', false),
  ('fiesta', 2, 'Rusty Egg of Magnetism', 600, 'uncommon', 90000, 24826787, 'bighead:#9aa3b8', false),
  ('fiesta', 3, 'Arctic Hood', 1000, 'uncommon', 90000, 18171366, 'bighead:#9aa3b8', false),
  ('fiesta', 4, 'Starry Egg of the Wild Ride', 1500, 'rare', 90000, 31151864, 'bighead:#9aa3b8', false),
  ('fiesta', 5, 'Ultimate Slide Skateboard', 3700, 'legendary', 31915, 52180878, 'bighead:#9aa3b8', true),
  ('fiesta', 6, 'Bloxxadore Domino Mask', 5200, 'legendary', 25532, 14492461, 'bighead:#9aa3b8', true),
  ('fiesta', 7, 'Black Paintball Mask', 6800, 'legendary', 21277, 9254521, 'bighead:#9aa3b8', true),
  ('fiesta', 8, '2010 Party Cap', 7100, 'legendary', 12766, 20044751, 'bighead:#9aa3b8', true),
  ('fiesta', 9, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 6383, 10351018, 'bighead:#9aa3b8', true),
  ('fiesta', 10, 'Bucket', 18000, 'legendary', 2128, 1081239, 'bighead:#9aa3b8', true),
  ('overgrown', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('overgrown', 1, 'Specular Egg of Red, No Blue', 400, 'common', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('overgrown', 2, 'Chaos Canyon Sugar Egg', 700, 'uncommon', 95000, 76692143, 'bighead:#9aa3b8', false),
  ('overgrown', 3, 'Turbo Builders Club Hard Hat', 1300, 'uncommon', 95000, 11844853, 'bighead:#9aa3b8', false),
  ('overgrown', 4, 'Blinking Egg of Relocation', 1800, 'rare', 95000, 1532381, 'bighead:#9aa3b8', false),
  ('overgrown', 5, 'Treehugger Visor', 5700, 'legendary', 15957, 9910514, 'bighead:#9aa3b8', true),
  ('overgrown', 6, 'Mandrake Root', 10400, 'legendary', 12766, 1191812, 'bighead:#9aa3b8', true),
  ('overgrown', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10638, 14817131, 'bighead:#9aa3b8', true),
  ('overgrown', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('overgrown', 9, 'Viridian Hood', 41200, 'legendary', 3191, 16954107, 'bighead:#9aa3b8', true),
  ('overgrown', 10, 'Lava Reactor', 101800, 'legendary', 1064, 32858948, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 1, 'Specular Egg of Red, No Blue', 400, 'common', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 2, 'Guardia in Exile', 800, 'uncommon', 95000, 18174901, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 3, 'Starry Egg of the Wild Ride', 1500, 'uncommon', 95000, 31151864, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 4, '2009 Graduation Cap', 2300, 'rare', 95000, 11721340, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 5, 'Invisible Egg of Shadow', 4900, 'legendary', 15957, 1532389, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 6, 'Robosquid', 9200, 'legendary', 12766, 37238566, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10638, 14817131, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 9, 'The Crown of Nachos', 44100, 'legendary', 3191, 22547617, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 10, 'Playful Vampire', 90000, 'legendary', 1064, 2409285794, 'bighead:#9aa3b8', true),
  ('orbit', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('orbit', 1, 'Specular Egg of Red, No Blue', 400, 'common', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('orbit', 2, 'Arctic Hood', 1000, 'uncommon', 99000, 18171366, 'bighead:#9aa3b8', false),
  ('orbit', 3, 'Christmas Baseball Cap', 2000, 'uncommon', 99000, 1272713, 'bighead:#9aa3b8', false),
  ('orbit', 4, 'The Moon', 2900, 'rare', 99000, 7319168, 'bighead:#9aa3b8', false),
  ('orbit', 5, 'Bag O'' Noobs', 11800, 'legendary', 3571, 32355759, 'bighead:#9aa3b8', true),
  ('orbit', 6, 'Seeing Stars', 18700, 'legendary', 2857, 27599954, 'bighead:#9aa3b8', true),
  ('orbit', 7, 'Viridian Hood', 41200, 'legendary', 1786, 16954107, 'bighead:#9aa3b8', true),
  ('orbit', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 1071, 47597760, 'bighead:#9aa3b8', true),
  ('orbit', 9, 'Super Super Happy Face', 162000, 'legendary', 536, 494291269, 'bighead:#9aa3b8', true),
  ('orbit', 10, 'Monstars Visor', 270000, 'legendary', 179, 1086815, 'bighead:#9aa3b8', true),
  ('martian', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('martian', 1, 'Chrome Egg of Speeding Bullet', 500, 'common', 270000, 24826640, 'bighead:#9aa3b8', false),
  ('martian', 2, 'Pink Penguin', 1400, 'uncommon', 90000, 16985920, 'bighead:#9aa3b8', false),
  ('martian', 3, 'Red Baseball Cap', 2500, 'uncommon', 90000, 1028606, 'bighead:#9aa3b8', false),
  ('martian', 4, 'Ultimate Slide Skateboard', 3700, 'rare', 90000, 52180878, 'bighead:#9aa3b8', false),
  ('martian', 5, 'Greenbot', 10200, 'legendary', 31915, 22023239, 'bighead:#9aa3b8', true),
  ('martian', 6, 'Ochre Ogre', 10900, 'legendary', 25532, 16723499, 'bighead:#9aa3b8', true),
  ('martian', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 21277, 14817131, 'bighead:#9aa3b8', true),
  ('martian', 8, 'Bucket', 18000, 'legendary', 12766, 1081239, 'bighead:#9aa3b8', true),
  ('martian', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('martian', 10, 'Viridian Hood', 41200, 'legendary', 2128, 16954107, 'bighead:#9aa3b8', true),
  ('blue-grin', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('blue-grin', 1, 'Chrome Egg of Speeding Bullet', 500, 'common', 285000, 24826640, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Starry Egg of the Wild Ride', 1500, 'uncommon', 95000, 31151864, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'Puzzling Egg of Enigma', 2600, 'uncommon', 95000, 1532386, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Headrow', 3900, 'rare', 95000, 1082935, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Seeing Stars', 18700, 'legendary', 15957, 27599954, 'bighead:#9aa3b8', true),
  ('blue-grin', 6, 'Mick McCann', 21100, 'legendary', 12766, 23264604, 'bighead:#9aa3b8', true),
  ('blue-grin', 7, 'Hotdog Head', 35800, 'legendary', 10638, 15318156, 'bighead:#9aa3b8', true),
  ('blue-grin', 8, 'The Bluesteel Bathelm', 63000, 'legendary', 6383, 1172161, 'bighead:#9aa3b8', true),
  ('blue-grin', 9, 'Lava Reactor', 101800, 'legendary', 3191, 32858948, 'bighead:#9aa3b8', true),
  ('blue-grin', 10, 'The Ice Skull of Nevermoor', 180000, 'legendary', 1064, 6552254, 'bighead:#9aa3b8', true),
  ('gearhead', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('gearhead', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 285000, 76692143, 'bighead:#9aa3b8', false),
  ('gearhead', 2, 'Blinking Egg of Relocation', 1800, 'uncommon', 95000, 1532381, 'bighead:#9aa3b8', false),
  ('gearhead', 3, 'Halloween Harbinger', 3300, 'uncommon', 95000, 15727771, 'bighead:#9aa3b8', false),
  ('gearhead', 4, 'Invisible Egg of Shadow', 4900, 'rare', 95000, 1532389, 'bighead:#9aa3b8', false),
  ('gearhead', 5, 'Kid Robot', 12500, 'legendary', 15957, 29283299, 'bighead:#9aa3b8', true),
  ('gearhead', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12766, 20980122, 'bighead:#9aa3b8', true),
  ('gearhead', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('gearhead', 8, 'Wildcard', 65400, 'legendary', 6383, 38322996, 'bighead:#9aa3b8', true),
  ('gearhead', 9, 'Even Eviler Jester', 106700, 'legendary', 3191, 40893465, 'bighead:#9aa3b8', true),
  ('gearhead', 10, 'Monstars Visor', 270000, 'legendary', 1064, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('gilded-night', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 297000, 76692143, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Blinking Egg of Relocation', 1800, 'uncommon', 99000, 1532381, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'Halloween Harbinger', 3300, 'uncommon', 99000, 15727771, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'The Viper Band', 5000, 'rare', 99000, 18482403, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'Seeing Stars', 18700, 'legendary', 3571, 27599954, 'bighead:#9aa3b8', true),
  ('gilded-night', 6, 'Golden Headphones', 52700, 'legendary', 2857, 29051524, 'bighead:#9aa3b8', true),
  ('gilded-night', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 1786, 47597760, 'bighead:#9aa3b8', true),
  ('gilded-night', 8, 'Super Super Happy Face', 162000, 'legendary', 1071, 494291269, 'bighead:#9aa3b8', true),
  ('gilded-night', 9, 'Monstars Visor', 270000, 'legendary', 536, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 10, 'Valkyrie Helm', 540000, 'legendary', 179, 1365767, 'bighead:#9aa3b8', true),
  ('spooky-beats', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('spooky-beats', 1, 'Guardia in Exile', 800, 'common', 285000, 18174901, 'bighead:#9aa3b8', false),
  ('spooky-beats', 2, 'Bouncing Egg of Boing Boing', 2200, 'uncommon', 95000, 1532384, 'bighead:#9aa3b8', false),
  ('spooky-beats', 3, 'The Earth', 4100, 'uncommon', 95000, 10072631, 'bighead:#9aa3b8', false),
  ('spooky-beats', 4, 'Gold Buckle Capotain', 6200, 'rare', 95000, 5671970, 'bighead:#9aa3b8', false),
  ('spooky-beats', 5, 'Bucket', 18000, 'legendary', 15957, 1081239, 'bighead:#9aa3b8', true),
  ('spooky-beats', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12766, 20980122, 'bighead:#9aa3b8', true),
  ('spooky-beats', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('spooky-beats', 8, 'The Bluesteel Bathelm', 63000, 'legendary', 6383, 1172161, 'bighead:#9aa3b8', true),
  ('spooky-beats', 9, 'Even Eviler Jester', 106700, 'legendary', 3191, 40893465, 'bighead:#9aa3b8', true),
  ('spooky-beats', 10, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1064, 1073690, 'bighead:#9aa3b8', true),
  ('atlantis', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('atlantis', 1, 'Racing Helmet', 900, 'common', 270000, 6379764, 'bighead:#9aa3b8', false),
  ('atlantis', 2, 'Red Baseball Cap', 2500, 'uncommon', 90000, 1028606, 'bighead:#9aa3b8', false),
  ('atlantis', 3, 'Black Lightning', 4600, 'uncommon', 90000, 29532225, 'bighead:#9aa3b8', false),
  ('atlantis', 4, 'Black Paintball Mask', 6800, 'rare', 90000, 9254521, 'bighead:#9aa3b8', false),
  ('atlantis', 5, 'Bucket', 18000, 'legendary', 31915, 1081239, 'bighead:#9aa3b8', true),
  ('atlantis', 6, 'Mick McCann', 21100, 'legendary', 25532, 23264604, 'bighead:#9aa3b8', true),
  ('atlantis', 7, 'Burning Otaku, the Firesouled', 24600, 'legendary', 21277, 20980122, 'bighead:#9aa3b8', true),
  ('atlantis', 8, 'Hotdog Head', 35800, 'legendary', 12766, 15318156, 'bighead:#9aa3b8', true),
  ('atlantis', 9, 'The Crown of Nachos', 44100, 'legendary', 6383, 22547617, 'bighead:#9aa3b8', true),
  ('atlantis', 10, 'The Bluesteel Bathelm', 63000, 'legendary', 2128, 1172161, 'bighead:#9aa3b8', true),
  ('ember', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('ember', 1, 'Arctic Hood', 1000, 'common', 270000, 18171366, 'bighead:#9aa3b8', false),
  ('ember', 2, 'Target Hat', 2700, 'uncommon', 90000, 1051578, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Invisible Egg of Shadow', 4900, 'uncommon', 90000, 1532389, 'bighead:#9aa3b8', false),
  ('ember', 4, 'White Witch Hat', 7300, 'rare', 90000, 5207053, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Burning Otaku, the Firesouled', 24600, 'legendary', 31915, 20980122, 'bighead:#9aa3b8', true),
  ('ember', 6, 'Hotdog Head', 35800, 'legendary', 25532, 15318156, 'bighead:#9aa3b8', true),
  ('ember', 7, 'Viridian Hood', 41200, 'legendary', 21277, 16954107, 'bighead:#9aa3b8', true),
  ('ember', 8, 'Imagine', 41400, 'legendary', 12766, 30394316, 'bighead:#9aa3b8', true),
  ('ember', 9, 'Golden Headphones', 52700, 'legendary', 6383, 29051524, 'bighead:#9aa3b8', true),
  ('ember', 10, 'Lava Reactor', 101800, 'legendary', 2128, 32858948, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Arctic Hood', 1000, 'common', 285000, 18171366, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'White Ninja Headband of the Unimpeachable Soul', 2800, 'uncommon', 95000, 11297746, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'The Viper Band', 5000, 'uncommon', 95000, 18482403, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'White Witch Hat', 7300, 'rare', 95000, 5207053, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Mick McCann', 21100, 'legendary', 15957, 23264604, 'bighead:#9aa3b8', true),
  ('topaz', 6, 'The Crown of Nachos', 44100, 'legendary', 12766, 22547617, 'bighead:#9aa3b8', true),
  ('topaz', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('topaz', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 6383, 47597760, 'bighead:#9aa3b8', true),
  ('topaz', 9, 'Super Super Happy Face', 162000, 'legendary', 3191, 494291269, 'bighead:#9aa3b8', true),
  ('topaz', 10, 'Monstars Visor', 270000, 'legendary', 1064, 1086815, 'bighead:#9aa3b8', true),
  ('tide-blade', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('tide-blade', 1, 'Stationary Egg of Boring', 1200, 'common', 297000, 1530795, 'bighead:#9aa3b8', false),
  ('tide-blade', 2, 'Halloween Harbinger', 3300, 'uncommon', 99000, 15727771, 'bighead:#9aa3b8', false),
  ('tide-blade', 3, 'Gold Buckle Capotain', 6200, 'uncommon', 99000, 5671970, 'bighead:#9aa3b8', false),
  ('tide-blade', 4, 'Robosquid', 9200, 'rare', 99000, 37238566, 'bighead:#9aa3b8', false),
  ('tide-blade', 5, 'Hotdog Head', 35800, 'legendary', 3571, 15318156, 'bighead:#9aa3b8', true),
  ('tide-blade', 6, 'Sword of the Winter Winds', 57600, 'legendary', 2857, 42847923, 'bighead:#9aa3b8', true),
  ('tide-blade', 7, 'Even Eviler Jester', 106700, 'legendary', 1786, 40893465, 'bighead:#9aa3b8', true),
  ('tide-blade', 8, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1071, 1073690, 'bighead:#9aa3b8', true),
  ('tide-blade', 9, 'Valkyrie Helm', 540000, 'legendary', 536, 1365767, 'bighead:#9aa3b8', true),
  ('tide-blade', 10, 'Spec Beta Biograft Energy Sword', 1260000, 'legendary', 179, 14876573, 'bighead:#9aa3b8', true),
  ('brass-samurai', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 380000, 24826640, 'bighead:#9aa3b8', false),
  ('brass-samurai', 1, 'Starry Egg of the Wild Ride', 1500, 'common', 285000, 31151864, 'bighead:#9aa3b8', false),
  ('brass-samurai', 2, 'Golden Egg of Kings', 4200, 'uncommon', 95000, 1532387, 'bighead:#9aa3b8', false),
  ('brass-samurai', 3, 'White Witch Hat', 7300, 'uncommon', 95000, 5207053, 'bighead:#9aa3b8', false),
  ('brass-samurai', 4, 'Hollywood Sign', 11300, 'rare', 95000, 17614445, 'bighead:#9aa3b8', false),
  ('brass-samurai', 5, 'Hotdog Head', 35800, 'legendary', 15957, 15318156, 'bighead:#9aa3b8', true),
  ('brass-samurai', 6, 'Golden Headphones', 52700, 'legendary', 12766, 29051524, 'bighead:#9aa3b8', true),
  ('brass-samurai', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 10638, 47597760, 'bighead:#9aa3b8', true),
  ('brass-samurai', 8, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('brass-samurai', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3191, 1073690, 'bighead:#9aa3b8', true),
  ('brass-samurai', 10, 'Valkyrie Helm', 540000, 'legendary', 1064, 1365767, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 380000, 24826640, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 1, 'Outrageous Builders Club Hard Hat', 1600, 'common', 285000, 17408283, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'Sci-Fi Santa', 4500, 'uncommon', 95000, 18729820, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'Das Deutschlandlied', 8400, 'uncommon', 95000, 26018282, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'Camoface', 12000, 'rare', 95000, 24441888, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Bubble Trouble', 57600, 'legendary', 15957, 19264845, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 6, 'Sundae Best', 74600, 'legendary', 12766, 35685322, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 7, 'Lava Reactor', 101800, 'legendary', 10638, 32858948, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 8, 'Super Super Happy Face', 162000, 'legendary', 6383, 494291269, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 9, 'Monstars Visor', 270000, 'legendary', 3191, 1086815, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 10, 'Wanwood Antlers', 630000, 'legendary', 1064, 1272714, 'bighead:#9aa3b8', true),
  ('shogun', 0, 'Rusty Egg of Magnetism', 600, 'common', 380000, 24826787, 'bighead:#9aa3b8', false),
  ('shogun', 1, 'Christmas Baseball Cap', 2000, 'common', 285000, 1272713, 'bighead:#9aa3b8', false),
  ('shogun', 2, 'Ladies Who Lunch', 5600, 'uncommon', 95000, 35167841, 'bighead:#9aa3b8', false),
  ('shogun', 3, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 95000, 10351018, 'bighead:#9aa3b8', false),
  ('shogun', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('shogun', 5, 'The Bluesteel Bathelm', 63000, 'legendary', 15957, 1172161, 'bighead:#9aa3b8', true),
  ('shogun', 6, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12766, 47597760, 'bighead:#9aa3b8', true),
  ('shogun', 7, 'Even Eviler Jester', 106700, 'legendary', 10638, 40893465, 'bighead:#9aa3b8', true),
  ('shogun', 8, 'Picklace', 192600, 'legendary', 6383, 33615415, 'bighead:#9aa3b8', true),
  ('shogun', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('shogun', 10, 'Helm of the Sacred Earth', 900000, 'legendary', 1064, 22157971, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Rusty Egg of Magnetism', 600, 'common', 380000, 24826787, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Kind Egg of Sharing', 2100, 'common', 285000, 1532395, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Santa Hat', 5800, 'uncommon', 95000, 1098277, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Mandrake Root', 10400, 'uncommon', 95000, 1191812, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Golden Headphones', 52700, 'legendary', 15957, 29051524, 'bighead:#9aa3b8', true),
  ('golden-snow', 6, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12766, 47597760, 'bighead:#9aa3b8', true),
  ('golden-snow', 7, 'Even Eviler Jester', 106700, 'legendary', 10638, 40893465, 'bighead:#9aa3b8', true),
  ('golden-snow', 8, 'Korblox King', 168200, 'legendary', 6383, 52492417, 'bighead:#9aa3b8', true),
  ('golden-snow', 9, 'Monstars Visor', 270000, 'legendary', 3191, 1086815, 'bighead:#9aa3b8', true),
  ('golden-snow', 10, 'Wanwood Antlers', 630000, 'legendary', 1064, 1272714, 'bighead:#9aa3b8', true),
  ('frostbite', 0, 'Chaos Canyon Sugar Egg', 700, 'common', 396000, 76692143, 'bighead:#9aa3b8', false),
  ('frostbite', 1, 'Bouncing Egg of Boing Boing', 2200, 'common', 297000, 1532384, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Gold Buckle Capotain', 6200, 'uncommon', 99000, 5671970, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Ochre Ogre', 10900, 'uncommon', 99000, 16723499, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Bucket', 18000, 'rare', 99000, 1081239, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'The Bluesteel Bathelm', 63000, 'legendary', 3571, 1172161, 'bighead:#9aa3b8', true),
  ('frostbite', 6, 'The Ice Skull of Nevermoor', 180000, 'legendary', 2857, 6552254, 'bighead:#9aa3b8', true),
  ('frostbite', 7, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1786, 1073690, 'bighead:#9aa3b8', true),
  ('frostbite', 8, 'Valkyrie Helm', 540000, 'legendary', 1071, 1365767, 'bighead:#9aa3b8', true),
  ('frostbite', 9, 'Green Ice Crown', 954000, 'legendary', 536, 193696233, 'bighead:#9aa3b8', true),
  ('frostbite', 10, 'Hooded Frostlord', 1800000, 'legendary', 179, 136802867, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Chaos Canyon Sugar Egg', 700, 'common', 360000, 76692143, 'bighead:#9aa3b8', false),
  ('pop-art', 1, '2009 Graduation Cap', 2300, 'common', 270000, 11721340, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'For the Ages: Abraham Lincoln', 6400, 'uncommon', 90000, 46363235, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Hollywood Sign', 11300, 'uncommon', 90000, 17614445, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Bucket', 18000, 'rare', 90000, 1081239, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Wildcard', 65400, 'legendary', 31915, 38322996, 'bighead:#9aa3b8', true),
  ('pop-art', 6, 'Sundae Best', 74600, 'legendary', 25532, 35685322, 'bighead:#9aa3b8', true),
  ('pop-art', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 21277, 47597760, 'bighead:#9aa3b8', true),
  ('pop-art', 8, 'Playful Vampire', 90000, 'legendary', 12766, 2409285794, 'bighead:#9aa3b8', true),
  ('pop-art', 9, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('pop-art', 10, 'Super Super Happy Face', 162000, 'legendary', 2128, 494291269, 'bighead:#9aa3b8', true),
  ('jurassic', 0, 'Guardia in Exile', 800, 'common', 360000, 18174901, 'bighead:#9aa3b8', false),
  ('jurassic', 1, 'Red Baseball Cap', 2500, 'common', 270000, 1028606, 'bighead:#9aa3b8', false),
  ('jurassic', 2, '2010 Party Cap', 7100, 'uncommon', 90000, 20044751, 'bighead:#9aa3b8', false),
  ('jurassic', 3, 'Kid Robot', 12500, 'uncommon', 90000, 29283299, 'bighead:#9aa3b8', false),
  ('jurassic', 4, 'Seeing Stars', 18700, 'rare', 90000, 27599954, 'bighead:#9aa3b8', false),
  ('jurassic', 5, 'The Crown of Nachos', 44100, 'legendary', 31915, 22547617, 'bighead:#9aa3b8', true),
  ('jurassic', 6, 'Pin Head', 56100, 'legendary', 25532, 25880554, 'bighead:#9aa3b8', true),
  ('jurassic', 7, 'Sundae Best', 74600, 'legendary', 21277, 35685322, 'bighead:#9aa3b8', true),
  ('jurassic', 8, 'Playful Vampire', 90000, 'legendary', 12766, 2409285794, 'bighead:#9aa3b8', true),
  ('jurassic', 9, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('jurassic', 10, 'Picklace', 192600, 'legendary', 2128, 33615415, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, 'Racing Helmet', 900, 'common', 380000, 6379764, 'bighead:#9aa3b8', false),
  ('midnight-holly', 1, 'The Moon', 2900, 'common', 285000, 7319168, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Das Deutschlandlied', 8400, 'uncommon', 95000, 26018282, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Mick McCann', 21100, 'rare', 95000, 23264604, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Even Eviler Jester', 106700, 'legendary', 15957, 40893465, 'bighead:#9aa3b8', true),
  ('midnight-holly', 6, 'Super Super Happy Face', 162000, 'legendary', 12766, 494291269, 'bighead:#9aa3b8', true),
  ('midnight-holly', 7, 'Korblox King', 168200, 'legendary', 10638, 52492417, 'bighead:#9aa3b8', true),
  ('midnight-holly', 8, 'Monstars Visor', 270000, 'legendary', 6383, 1086815, 'bighead:#9aa3b8', true),
  ('midnight-holly', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('midnight-holly', 10, 'Pink Queen of the Night', 1026000, 'legendary', 1064, 553971558, 'bighead:#9aa3b8', true),
  ('viking-ember', 0, 'Arctic Hood', 1000, 'common', 380000, 18171366, 'bighead:#9aa3b8', false),
  ('viking-ember', 1, 'Blue Winter Cap', 3500, 'common', 285000, 1309918, 'bighead:#9aa3b8', false),
  ('viking-ember', 2, 'Cyborg Soldier', 9400, 'uncommon', 95000, 27052155, 'bighead:#9aa3b8', false),
  ('viking-ember', 3, 'Bucket', 18000, 'uncommon', 95000, 1081239, 'bighead:#9aa3b8', false),
  ('viking-ember', 4, 'Burning Otaku, the Firesouled', 24600, 'rare', 95000, 20980122, 'bighead:#9aa3b8', false),
  ('viking-ember', 5, 'The Bluesteel Bathelm', 63000, 'legendary', 15957, 1172161, 'bighead:#9aa3b8', true),
  ('viking-ember', 6, 'Lava Reactor', 101800, 'legendary', 12766, 32858948, 'bighead:#9aa3b8', true),
  ('viking-ember', 7, 'Korblox King', 168200, 'legendary', 10638, 52492417, 'bighead:#9aa3b8', true),
  ('viking-ember', 8, 'Monstars Visor', 270000, 'legendary', 6383, 1086815, 'bighead:#9aa3b8', true),
  ('viking-ember', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('viking-ember', 10, 'Helm of the Sacred Earth', 900000, 'legendary', 1064, 22157971, 'bighead:#9aa3b8', true),
  ('nevermoor', 0, 'Starry Egg of the Wild Ride', 1500, 'common', 380000, 31151864, 'bighead:#9aa3b8', false),
  ('nevermoor', 1, 'The Viper Band', 5000, 'common', 285000, 18482403, 'bighead:#9aa3b8', false),
  ('nevermoor', 2, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('nevermoor', 3, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 95000, 20980122, 'bighead:#9aa3b8', false),
  ('nevermoor', 4, 'Hotdog Head', 35800, 'rare', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('nevermoor', 5, 'Lava Reactor', 101800, 'legendary', 15957, 32858948, 'bighead:#9aa3b8', true),
  ('nevermoor', 6, 'The Ice Skull of Nevermoor', 180000, 'legendary', 12766, 6552254, 'bighead:#9aa3b8', true),
  ('nevermoor', 7, 'JJ5x5''s White Top Hat', 243000, 'legendary', 10638, 1073690, 'bighead:#9aa3b8', true),
  ('nevermoor', 8, 'Valkyrie Helm', 540000, 'legendary', 6383, 1365767, 'bighead:#9aa3b8', true),
  ('nevermoor', 9, 'Ice Valkyrie', 738000, 'legendary', 3191, 4390891467, 'bighead:#9aa3b8', true),
  ('nevermoor', 10, 'Hooded Frostlord', 1800000, 'legendary', 1064, 136802867, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Christmas Baseball Cap', 2000, 'common', 360000, 1272713, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'For the Ages: Abraham Lincoln', 6400, 'common', 270000, 46363235, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'Bucket', 18000, 'uncommon', 90000, 1081239, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Hotdog Head', 35800, 'uncommon', 90000, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'Golden Headphones', 52700, 'rare', 90000, 29051524, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Super Super Happy Face', 162000, 'legendary', 34091, 494291269, 'bighead:#9aa3b8', true),
  ('smiley', 6, 'Korblox King', 168200, 'legendary', 27273, 52492417, 'bighead:#9aa3b8', true),
  ('smiley', 7, 'The Ice Skull of Nevermoor', 180000, 'legendary', 22727, 6552254, 'bighead:#9aa3b8', true),
  ('smiley', 8, 'Monstars Visor', 270000, 'legendary', 13636, 1086815, 'bighead:#9aa3b8', true),
  ('smiley', 9, 'Valkyrie Helm', 540000, 'legendary', 2273, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Christmas Baseball Cap', 2000, 'common', 380000, 1272713, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'Black Paintball Mask', 6800, 'common', 285000, 9254521, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Seeing Stars', 18700, 'uncommon', 95000, 27599954, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Hotdog Head', 35800, 'uncommon', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'Golden Headphones', 52700, 'rare', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'JJ5x5''s White Top Hat', 243000, 'legendary', 15957, 1073690, 'bighead:#9aa3b8', true),
  ('tropical-pop', 6, 'Monstars Visor', 270000, 'legendary', 12766, 1086815, 'bighead:#9aa3b8', true),
  ('tropical-pop', 7, 'Valkyrie Helm', 540000, 'legendary', 10638, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 8, 'Wanwood Antlers', 630000, 'legendary', 6383, 1272714, 'bighead:#9aa3b8', true),
  ('tropical-pop', 9, 'Collision Top Hat', 990000, 'legendary', 3191, 158068251, 'bighead:#9aa3b8', true),
  ('tropical-pop', 10, 'Red Crown of Ozymandias', 1980000, 'legendary', 1064, 9465511, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, 'Bouncing Egg of Boing Boing', 2200, 'common', 380000, 1532384, 'bighead:#9aa3b8', false),
  ('retro-wave', 1, 'Traffic Cone', 7200, 'common', 285000, 1082932, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Mick McCann', 21100, 'uncommon', 95000, 23264604, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'Hotdog Head', 35800, 'uncommon', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'Golden Headphones', 52700, 'rare', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Monstars Visor', 270000, 'legendary', 21429, 1086815, 'bighead:#9aa3b8', true),
  ('retro-wave', 6, 'Valkyrie Helm', 540000, 'legendary', 14286, 1365767, 'bighead:#9aa3b8', true),
  ('retro-wave', 7, 'Glorious Purple Party Queen', 936000, 'legendary', 8571, 258184056, 'bighead:#9aa3b8', true),
  ('retro-wave', 8, 'Clockwork''s Headphones', 1440000, 'legendary', 4286, 1235488, 'bighead:#9aa3b8', true),
  ('retro-wave', 9, 'Retro 80s Headphones', 2520000, 'legendary', 1429, 29844011, 'bighead:#9aa3b8', true),
  ('eclipse', 0, '2009 Graduation Cap', 2300, 'common', 396000, 11721340, 'bighead:#9aa3b8', false),
  ('eclipse', 1, 'White Witch Hat', 7300, 'common', 297000, 5207053, 'bighead:#9aa3b8', false),
  ('eclipse', 2, 'Mick McCann', 21100, 'uncommon', 99000, 23264604, 'bighead:#9aa3b8', false),
  ('eclipse', 3, 'Hotdog Head', 35800, 'uncommon', 99000, 15318156, 'bighead:#9aa3b8', false),
  ('eclipse', 4, 'Pin Head', 56100, 'rare', 99000, 25880554, 'bighead:#9aa3b8', false),
  ('eclipse', 5, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3571, 1073690, 'bighead:#9aa3b8', true),
  ('eclipse', 6, 'Valkyrie Helm', 540000, 'legendary', 2857, 1365767, 'bighead:#9aa3b8', true),
  ('eclipse', 7, 'Silver King of the Night', 846000, 'legendary', 1786, 439945661, 'bighead:#9aa3b8', true),
  ('eclipse', 8, 'Dark Cerulean Crown of Ozymandias', 1512000, 'legendary', 1071, 13370505, 'bighead:#9aa3b8', true),
  ('eclipse', 9, 'Crown of Om Nom Nom', 3060000, 'legendary', 536, 21070350, 'bighead:#9aa3b8', true),
  ('eclipse', 10, 'Gaze of Socom1880', 6120000, 'legendary', 179, 14671091, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, 'Halloween Harbinger', 3300, 'common', 396000, 15727771, 'bighead:#9aa3b8', false),
  ('shadow-beats', 1, 'Ochre Ogre', 10900, 'common', 297000, 16723499, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'Hotdog Head', 35800, 'uncommon', 99000, 15318156, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'Pin Head', 56100, 'uncommon', 99000, 25880554, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Golden Chakram of the Sky Palace', 77000, 'rare', 99000, 47597760, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Monstars Visor', 270000, 'legendary', 3571, 1086815, 'bighead:#9aa3b8', true),
  ('shadow-beats', 6, 'Silver King of the Night', 846000, 'legendary', 2857, 439945661, 'bighead:#9aa3b8', true),
  ('shadow-beats', 7, 'Pink Queen of the Night', 1026000, 'legendary', 1786, 553971558, 'bighead:#9aa3b8', true),
  ('shadow-beats', 8, 'Vaiobot''s Moneylicious Tie', 2250000, 'legendary', 1071, 30371876, 'bighead:#9aa3b8', true),
  ('shadow-beats', 9, 'Sword Cane', 4320000, 'legendary', 536, 25740034, 'bighead:#9aa3b8', true),
  ('shadow-beats', 10, 'Black Iron King of the Night', 10800000, 'legendary', 179, 439946249, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'Ladies Who Lunch', 5600, 'common', 380000, 35167841, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'Bucket', 18000, 'common', 285000, 1081239, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'Golden Headphones', 52700, 'uncommon', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Playful Vampire', 90000, 'uncommon', 95000, 2409285794, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Super Super Happy Face', 162000, 'rare', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'Wanwood Antlers', 630000, 'legendary', 15957, 1272714, 'bighead:#9aa3b8', true),
  ('arctic-moss', 6, 'Ice Valkyrie', 738000, 'legendary', 12766, 4390891467, 'bighead:#9aa3b8', true),
  ('arctic-moss', 7, 'Green Ice Crown', 954000, 'legendary', 10638, 193696233, 'bighead:#9aa3b8', true),
  ('arctic-moss', 8, 'Helm of the Great Tree', 1350000, 'legendary', 6383, 9910420, 'bighead:#9aa3b8', true),
  ('arctic-moss', 9, 'Green Bow Tie', 2700000, 'legendary', 3191, 16598513, 'bighead:#9aa3b8', true),
  ('arctic-moss', 10, 'The Ice Crown', 7200000, 'legendary', 1064, 1323384, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'One Star General''s Beret', 6700, 'common', 360000, 28039679, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Mick McCann', 21100, 'common', 270000, 23264604, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'The Bluesteel Bathelm', 63000, 'uncommon', 90000, 1172161, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Even Eviler Jester', 106700, 'uncommon', 90000, 40893465, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Super Super Happy Face', 162000, 'rare', 90000, 494291269, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'Valkyrie Helm', 540000, 'legendary', 31915, 1365767, 'bighead:#9aa3b8', true),
  ('sunbeam', 6, 'Ice Valkyrie', 738000, 'legendary', 25532, 4390891467, 'bighead:#9aa3b8', true),
  ('sunbeam', 7, 'Helm of the Sacred Earth', 900000, 'legendary', 21277, 22157971, 'bighead:#9aa3b8', true),
  ('sunbeam', 8, 'Goldlika: Hero', 936000, 'legendary', 12766, 323419455, 'bighead:#9aa3b8', true),
  ('sunbeam', 9, 'Headdress of Aken-Aten, the Sun King', 1080000, 'legendary', 6383, 18482398, 'bighead:#9aa3b8', true),
  ('sunbeam', 10, 'GoldLika: Troll', 1530000, 'legendary', 2128, 398674241, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, 'Cyborg Soldier', 9400, 'common', 380000, 27052155, 'bighead:#9aa3b8', false),
  ('neon-pop', 1, 'Hotdog Head', 35800, 'common', 285000, 15318156, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Playful Vampire', 90000, 'uncommon', 95000, 2409285794, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'Super Super Happy Face', 162000, 'uncommon', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 95000, 1073690, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'Neon Purple Crazy Crown', 1116000, 'legendary', 15957, 376805769, 'bighead:#9aa3b8', true),
  ('neon-pop', 6, 'Crazy Glasses', 1350000, 'legendary', 12766, 16646369, 'bighead:#9aa3b8', true),
  ('neon-pop', 7, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 10638, 188888052, 'bighead:#9aa3b8', true),
  ('neon-pop', 8, 'Neon Green Crazy Crown', 2430000, 'legendary', 6383, 321346616, 'bighead:#9aa3b8', true),
  ('neon-pop', 9, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 3191, 315549204, 'bighead:#9aa3b8', true),
  ('neon-pop', 10, '): Red Grind', 11700000, 'legendary', 1064, 20573086, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, 'Cyborg Soldier', 9400, 'common', 396000, 27052155, 'bighead:#9aa3b8', false),
  ('crystal-beats', 1, 'Hotdog Head', 35800, 'common', 297000, 15318156, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'Playful Vampire', 90000, 'uncommon', 99000, 2409285794, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'Super Super Happy Face', 162000, 'uncommon', 99000, 494291269, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 99000, 1073690, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'Green Ice Crown', 954000, 'legendary', 3571, 193696233, 'bighead:#9aa3b8', true),
  ('crystal-beats', 6, 'Retro 80s Headphones', 2520000, 'legendary', 2857, 29844011, 'bighead:#9aa3b8', true),
  ('crystal-beats', 7, 'Yellow Glowing Eyes', 3240000, 'legendary', 1786, 416846000, 'bighead:#9aa3b8', true),
  ('crystal-beats', 8, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 1071, 315549204, 'bighead:#9aa3b8', true),
  ('crystal-beats', 9, 'WC Ultimates: Aquamarine Attitude', 17100000, 'legendary', 536, 323417812, 'bighead:#9aa3b8', true),
  ('crystal-beats', 10, 'Eerie Pumpkin Head', 36000000, 'legendary', 179, 1158416, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Camoface', 12000, 'common', 380000, 24441888, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Viridian Hood', 41200, 'common', 285000, 16954107, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'Even Eviler Jester', 106700, 'uncommon', 95000, 40893465, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Picklace', 192600, 'uncommon', 95000, 33615415, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Monstars Visor', 270000, 'rare', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('lime-grin', 5, 'Clockwork''s Headphones', 1440000, 'legendary', 15957, 1235488, 'bighead:#9aa3b8', true),
  ('lime-grin', 6, 'GoldLika: Troll', 1530000, 'legendary', 12766, 398674241, 'bighead:#9aa3b8', true),
  ('lime-grin', 7, 'Neon Green Crazy Crown', 2430000, 'legendary', 10638, 321346616, 'bighead:#9aa3b8', true),
  ('lime-grin', 8, 'Yellow Glowing Eyes', 3240000, 'legendary', 6383, 416846000, 'bighead:#9aa3b8', true),
  ('lime-grin', 9, 'Gaze of Socom1880', 6120000, 'legendary', 3191, 14671091, 'bighead:#9aa3b8', true),
  ('lime-grin', 10, '): Red Grind', 11700000, 'legendary', 1064, 20573086, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'Bucket', 18000, 'common', 360000, 1081239, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'Golden Headphones', 52700, 'common', 270000, 29051524, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'Super Super Happy Face', 162000, 'uncommon', 90000, 494291269, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'Monstars Visor', 270000, 'uncommon', 90000, 1086815, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'Valkyrie Helm', 540000, 'rare', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('mistletoe', 5, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 31915, 149594212, 'bighead:#9aa3b8', true),
  ('mistletoe', 6, 'Immortal Sword: Endless Ice Slasher', 1800000, 'legendary', 25532, 568920951, 'bighead:#9aa3b8', true),
  ('mistletoe', 7, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 21277, 188888052, 'bighead:#9aa3b8', true),
  ('mistletoe', 8, 'Neon Green Crazy Crown', 2430000, 'legendary', 12766, 321346616, 'bighead:#9aa3b8', true),
  ('mistletoe', 9, 'Green Bow Tie', 2700000, 'legendary', 6383, 16598513, 'bighead:#9aa3b8', true),
  ('mistletoe', 10, 'Sparkle Time Fedora', 4500000, 'legendary', 2128, 1285307, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, 'Bucket', 18000, 'common', 380000, 1081239, 'bighead:#9aa3b8', false),
  ('winter-crown', 1, 'Pin Head', 56100, 'common', 285000, 25880554, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Super Super Happy Face', 162000, 'uncommon', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Valkyrie Helm', 540000, 'rare', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Red Crown of Ozymandias', 1980000, 'legendary', 15957, 9465511, 'bighead:#9aa3b8', true),
  ('winter-crown', 6, 'Neon Green Crazy Crown', 2430000, 'legendary', 12766, 321346616, 'bighead:#9aa3b8', true),
  ('winter-crown', 7, 'Crown of Om Nom Nom', 3060000, 'legendary', 10638, 21070350, 'bighead:#9aa3b8', true),
  ('winter-crown', 8, 'The Void Star', 5580000, 'legendary', 6383, 1125510, 'bighead:#9aa3b8', true),
  ('winter-crown', 9, 'Black Iron King of the Night', 10800000, 'legendary', 3191, 439946249, 'bighead:#9aa3b8', true),
  ('winter-crown', 10, 'Darkheart', 21600000, 'legendary', 1064, 16895215, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'Hotdog Head', 35800, 'common', 360000, 15318156, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'Lava Reactor', 101800, 'common', 270000, 32858948, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'Monstars Visor', 270000, 'uncommon', 90000, 1086815, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Valkyrie Helm', 540000, 'uncommon', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Ice Valkyrie', 738000, 'rare', 90000, 4390891467, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 31915, 188004500, 'bighead:#9aa3b8', true),
  ('violet-beats', 6, 'Crown of the Undead Hoard', 2610000, 'legendary', 25532, 31046644, 'bighead:#9aa3b8', true),
  ('violet-beats', 7, 'Chrononoctis: The Ominous Helm', 2790000, 'legendary', 21277, 161211371, 'bighead:#9aa3b8', true),
  ('violet-beats', 8, 'CW Ultimate: Rose Quartz Rebellion', 3600000, 'legendary', 12766, 228449574, 'bighead:#9aa3b8', true),
  ('violet-beats', 9, 'Steampunk Aetherspectacles', 4860000, 'legendary', 6383, 12908119, 'bighead:#9aa3b8', true),
  ('violet-beats', 10, 'Dominus Rex', 7920000, 'legendary', 2128, 250395631, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'Hotdog Head', 35800, 'common', 380000, 15318156, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'Lava Reactor', 101800, 'common', 285000, 32858948, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Ice Valkyrie', 738000, 'rare', 95000, 4390891467, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 15957, 74891470, 'bighead:#9aa3b8', true),
  ('glacier', 6, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 12766, 215718515, 'bighead:#9aa3b8', true),
  ('glacier', 7, 'Steampunk Aetherspectacles', 4860000, 'legendary', 10638, 12908119, 'bighead:#9aa3b8', true),
  ('glacier', 8, 'The Ice Crown', 7200000, 'legendary', 6383, 1323384, 'bighead:#9aa3b8', true),
  ('glacier', 9, 'The Wanwood Crown', 14400000, 'legendary', 3191, 9910070, 'bighead:#9aa3b8', true),
  ('glacier', 10, 'Eerie Pumpkin Head', 36000000, 'legendary', 1064, 1158416, 'bighead:#9aa3b8', true),
  ('evergreen', 0, 'Hotdog Head', 35800, 'common', 380000, 15318156, 'bighead:#9aa3b8', false),
  ('evergreen', 1, 'Lava Reactor', 101800, 'common', 285000, 32858948, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Ice Valkyrie', 738000, 'rare', 95000, 4390891467, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Green Glowing Eyes', 3780000, 'legendary', 15957, 398676450, 'bighead:#9aa3b8', true),
  ('evergreen', 6, 'CW Ultimate: Emerald Entropy', 4320000, 'legendary', 12766, 271015154, 'bighead:#9aa3b8', true),
  ('evergreen', 7, 'Gaze of Socom1880', 6120000, 'legendary', 10638, 14671091, 'bighead:#9aa3b8', true),
  ('evergreen', 8, 'Red Glowing Eyes', 8280000, 'legendary', 6383, 180660043, 'bighead:#9aa3b8', true),
  ('evergreen', 9, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 3191, 489196035, 'bighead:#9aa3b8', true),
  ('evergreen', 10, 'Domino Crown', 43200000, 'legendary', 1064, 1031429, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'The Crown of Nachos', 44100, 'common', 360000, 22547617, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'Super Super Happy Face', 162000, 'common', 270000, 494291269, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'Valkyrie Helm', 540000, 'uncommon', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Silver King of the Night', 846000, 'uncommon', 90000, 439945661, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'Crown of Tones', 1188000, 'rare', 90000, 152173424, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 31915, 215718515, 'bighead:#9aa3b8', true),
  ('fire-ice', 6, ':( Front Stand', 4050000, 'legendary', 25532, 321346550, 'bighead:#9aa3b8', true),
  ('fire-ice', 7, 'Sparkle Time Fedora', 4500000, 'legendary', 21277, 1285307, 'bighead:#9aa3b8', true),
  ('fire-ice', 8, 'The Ice Crown', 7200000, 'legendary', 12766, 1323384, 'bighead:#9aa3b8', true),
  ('fire-ice', 9, 'Red Glowing Eyes', 8280000, 'legendary', 6383, 180660043, 'bighead:#9aa3b8', true),
  ('fire-ice', 10, '): Red Grind', 11700000, 'legendary', 2128, 20573086, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'Golden Headphones', 52700, 'common', 380000, 29051524, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'Korblox King', 168200, 'common', 285000, 52492417, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'Silver King of the Night', 846000, 'uncommon', 95000, 439945661, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'Spec Beta Biograft Energy Sword', 1260000, 'rare', 95000, 14876573, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Azurewrath, Lord of the Void', 3420000, 'legendary', 15957, 17109706, 'bighead:#9aa3b8', true),
  ('black-ice', 6, 'The Ice Crown', 7200000, 'legendary', 12766, 1323384, 'bighead:#9aa3b8', true),
  ('black-ice', 7, 'Black Iron King of the Night', 10800000, 'legendary', 10638, 439946249, 'bighead:#9aa3b8', true),
  ('black-ice', 8, 'The Crown of Roses', 13500000, 'legendary', 6383, 17449820, 'bighead:#9aa3b8', true),
  ('black-ice', 9, 'Darkheart', 21600000, 'legendary', 3191, 16895215, 'bighead:#9aa3b8', true),
  ('black-ice', 10, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1064, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 0, 'Playful Vampire', 90000, 'common', 396000, 2409285794, 'bighead:#9aa3b8', false),
  ('amethyst', 1, 'Monstars Visor', 270000, 'common', 297000, 1086815, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'Ice Valkyrie', 738000, 'uncommon', 99000, 4390891467, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'Dominus Praefectus', 1422000, 'uncommon', 99000, 527365852, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Red Crown of Ozymandias', 1980000, 'rare', 99000, 9465511, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'Countess of the Federation', 9000000, 'legendary', 3571, 188003914, 'bighead:#9aa3b8', true),
  ('amethyst', 6, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 2857, 215751161, 'bighead:#9aa3b8', true),
  ('amethyst', 7, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 1786, 63043890, 'bighead:#9aa3b8', true),
  ('amethyst', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1071, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 9, 'Dominus Astra', 108000000, 'legendary', 536, 162067148, 'bighead:#9aa3b8', true),
  ('amethyst', 10, 'Dominus Empyreus', 198000000, 'legendary', 179, 21070012, 'bighead:#9aa3b8', true),
  ('jade', 0, 'Super Super Happy Face', 162000, 'common', 380000, 494291269, 'bighead:#9aa3b8', false),
  ('jade', 1, 'Valkyrie Helm', 540000, 'common', 285000, 1365767, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Dominus Praefectus', 1422000, 'uncommon', 95000, 527365852, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Clockwork''s Shades', 2520000, 'uncommon', 95000, 11748356, 'bighead:#9aa3b8', false),
  ('jade', 4, 'Green Glowing Eyes', 3780000, 'rare', 95000, 398676450, 'bighead:#9aa3b8', false),
  ('jade', 5, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 15957, 147180077, 'bighead:#9aa3b8', true),
  ('jade', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12766, 493476042, 'bighead:#9aa3b8', true),
  ('jade', 7, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 10638, 63043890, 'bighead:#9aa3b8', true),
  ('jade', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6383, 259423244, 'bighead:#9aa3b8', true),
  ('jade', 9, 'Dominus Astra', 108000000, 'legendary', 3191, 162067148, 'bighead:#9aa3b8', true),
  ('jade', 10, 'Dominus Empyreus', 198000000, 'legendary', 1064, 21070012, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Picklace', 192600, 'common', 360000, 33615415, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'Wanwood Antlers', 630000, 'common', 270000, 1272714, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Hooded Frostlord', 1800000, 'uncommon', 90000, 136802867, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'Cultural Item', 3240000, 'uncommon', 90000, 14462955, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Steampunk Aetherspectacles', 4860000, 'rare', 90000, 12908119, 'bighead:#9aa3b8', false),
  ('sapphire', 5, '): Red Grind', 11700000, 'legendary', 31915, 20573086, 'bighead:#9aa3b8', true),
  ('sapphire', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 25532, 493476042, 'bighead:#9aa3b8', true),
  ('sapphire', 7, '): Euro 180', 22500000, 'legendary', 21277, 23705521, 'bighead:#9aa3b8', true),
  ('sapphire', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 12766, 63043890, 'bighead:#9aa3b8', true),
  ('sapphire', 9, 'Domino Crown', 43200000, 'legendary', 6383, 1031429, 'bighead:#9aa3b8', true),
  ('sapphire', 10, 'Black Sparkle Time Fedora', 45000000, 'legendary', 2128, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'JJ5x5''s White Top Hat', 243000, 'common', 380000, 1073690, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Ice Valkyrie', 738000, 'common', 285000, 4390891467, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'Vaiobot''s Moneylicious Tie', 2250000, 'uncommon', 95000, 30371876, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Green Glowing Eyes', 3780000, 'uncommon', 95000, 398676450, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'The Void Star', 5580000, 'rare', 95000, 1125510, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'The Wanwood Crown', 14400000, 'legendary', 15957, 9910070, 'bighead:#9aa3b8', true),
  ('sunset-remix', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12766, 493476042, 'bighead:#9aa3b8', true),
  ('sunset-remix', 7, 'Domino Crown', 43200000, 'legendary', 10638, 1031429, 'bighead:#9aa3b8', true),
  ('sunset-remix', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6383, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 9, 'Dominus Astra', 108000000, 'legendary', 3191, 162067148, 'bighead:#9aa3b8', true),
  ('sunset-remix', 10, 'Dominus Empyreus', 198000000, 'legendary', 1064, 21070012, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'Silver King of the Night', 846000, 'common', 360000, 439945661, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'Chrononoctis: The Ominous Helm', 2790000, 'common', 270000, 161211371, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, 'Dominus Rex', 7920000, 'uncommon', 90000, 250395631, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'The Wanwood Crown', 14400000, 'uncommon', 90000, 9910070, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Darkheart', 21600000, 'rare', 90000, 16895215, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Black Sparkle Time Fedora', 45000000, 'legendary', 34091, 259423244, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 6, 'Dominus Astra', 108000000, 'legendary', 27273, 162067148, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 7, 'Dominus Infernus', 126000000, 'legendary', 22727, 31101391, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 8, 'Dominus Frigidus', 162000000, 'legendary', 13636, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 9, 'Dominus Empyreus', 198000000, 'legendary', 2273, 21070012, 'bighead:#9aa3b8', true);

-- Leaderboard: admins can hide a player (their wagers stop counting and they vanish from the board)
alter table public.profiles add column if not exists lb_hidden boolean not null default false;

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
  if coalesce((select lb_hidden from public.profiles where id = p_uid), false) then return; end if;
  insert into public.weekly_wagers (week_start, user_id, wagered, updated_at)
  values (public.lb_week(), p_uid, p_amount, now())
  on conflict (week_start, user_id) do update
    set wagered = public.weekly_wagers.wagered + excluded.wagered, updated_at = now();
end $$;


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
        from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)
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


create or replace function public.get_leaderboard()
returns json language plpgsql volatile security definer set search_path = public as $$
declare w date := public.lb_week(); prizes bigint[] := public.lb_prizes(); v_me json; v_top json; v_last json;
begin
  perform public.lb_settle();
  select coalesce(json_agg(t order by t.rank), '[]') into v_top from (
    select row_number() over (order by ww.wagered desc, ww.updated_at) as rank, ww.user_id, p.username, ww.wagered,
           public.level_of(p.wagered) as level
      from public.weekly_wagers ww join public.profiles p on p.id = ww.user_id
     where ww.week_start = w and ww.wagered > 0 and not p.lb_hidden
     order by ww.wagered desc, ww.updated_at limit 50) t;
  if auth.uid() is not null then
    select json_build_object('rank', t.rank, 'wagered', coalesce(t.wagered, 0)) into v_me from (
      select rank, wagered from (
        select user_id, wagered, row_number() over (order by wagered desc, updated_at) as rank
          from public.weekly_wagers where week_start = w and wagered > 0 and user_id not in (select id from public.profiles where lb_hidden)) x
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


create or replace function public.admin_set_lb_hidden(p_user uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.profiles set lb_hidden = p_hidden where id = p_user;
end $$;

create or replace function public.admin_find(p_q text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(json_agg(t order by t.wagered desc), '[]') from (
    select p.id, p.username, u.email, p.coins, p.wagered, p.created_at, p.is_admin, p.lb_hidden
      from public.profiles p left join auth.users u on u.id = p.id
     where p_q is null or p_q = '' or p.username ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
     order by p.wagered desc limit 25) t);
end $$;

-- (permissions are set by the later updates)

-- =====================================================================
-- Included: update 12 (borrow slider)
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

-- =====================================================================
-- Included: update 13 (gold dice prizes at least 2.2x)
-- =====================================================================
delete from public.case_items where case_id in ('peppermint','crystal-egg','faberge','zombie-horde','haunted-patch','fiesta','overgrown','dragon-hatch','orbit','martian','blue-grin','gearhead','gilded-night','spooky-beats','atlantis','ember','topaz','tide-blade','brass-samurai','bubblegum-grin','shogun','golden-snow','frostbite','pop-art','jurassic','midnight-holly','viking-ember','nevermoor','smiley','tropical-pop','retro-wave','eclipse','shadow-beats','arctic-moss','sunbeam','neon-pop','crystal-beats','lime-grin','mistletoe','winter-crown','violet-beats','glacier','evergreen','fire-ice','black-ice','amethyst','jade','sapphire','sunset-remix','ultimate-grin');
insert into public.case_items (case_id, idx, name, value, rarity, weight, catalog_id, art, top) values
  ('peppermint', 0, 'POW! To the Moon! Egg', 400, 'rare', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('peppermint', 1, 'Specular Egg of Red, No Blue', 400, 'rare', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('peppermint', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'rare', 95000, 24826811, 'bighead:#9aa3b8', false),
  ('peppermint', 3, 'Unassuming Egg of Shyness', 400, 'rare', 95000, 24826840, 'bighead:#9aa3b8', false),
  ('peppermint', 4, 'Chrome Egg of Speeding Bullet', 500, 'rare', 95000, 24826640, 'bighead:#9aa3b8', false),
  ('peppermint', 5, 'Blue Swashbuckler', 2200, 'legendary', 15957, 25535420, 'bighead:#9aa3b8', true),
  ('peppermint', 6, 'Bouncing Egg of Boing Boing', 2200, 'legendary', 12766, 1532384, 'bighead:#9aa3b8', true),
  ('peppermint', 7, 'Blue Winter Cap', 3500, 'legendary', 10638, 1309918, 'bighead:#9aa3b8', true),
  ('peppermint', 8, 'Sci-Fi Santa', 4500, 'legendary', 6383, 18729820, 'bighead:#9aa3b8', true),
  ('peppermint', 9, '2010 Party Cap', 7100, 'legendary', 3191, 20044751, 'bighead:#9aa3b8', true),
  ('peppermint', 10, 'Bucket', 18000, 'legendary', 1064, 1081239, 'bighead:#9aa3b8', true),
  ('crystal-egg', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('crystal-egg', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 270000, 24826800, 'bighead:#9aa3b8', false),
  ('crystal-egg', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 90000, 24826811, 'bighead:#9aa3b8', false),
  ('crystal-egg', 3, 'Unassuming Egg of Shyness', 400, 'uncommon', 90000, 24826840, 'bighead:#9aa3b8', false),
  ('crystal-egg', 4, 'Chrome Egg of Speeding Bullet', 500, 'rare', 90000, 24826640, 'bighead:#9aa3b8', false),
  ('crystal-egg', 5, 'American Baseball Cap', 2500, 'legendary', 31915, 29715020, 'bighead:#9aa3b8', true),
  ('crystal-egg', 6, 'Pumpkin Pi', 2500, 'legendary', 25532, 16986805, 'bighead:#9aa3b8', true),
  ('crystal-egg', 7, 'Red Baseball Cap', 2500, 'legendary', 21277, 1028606, 'bighead:#9aa3b8', true),
  ('crystal-egg', 8, 'Puzzling Egg of Enigma', 2600, 'legendary', 12766, 1532386, 'bighead:#9aa3b8', true),
  ('crystal-egg', 9, 'Green Fabergé Egg', 3300, 'legendary', 6383, 24832637, 'bighead:#9aa3b8', true),
  ('crystal-egg', 10, 'Invisible Egg of Shadow', 4900, 'legendary', 2128, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('faberge', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('faberge', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 99000, 24826811, 'bighead:#9aa3b8', false),
  ('faberge', 3, 'Chrome Egg of Speeding Bullet', 500, 'uncommon', 99000, 24826640, 'bighead:#9aa3b8', false),
  ('faberge', 4, 'Guardia in Exile', 800, 'rare', 99000, 18174901, 'bighead:#9aa3b8', false),
  ('faberge', 5, 'Fried Egg Eye Patch', 3100, 'legendary', 3571, 63647492, 'bighead:#9aa3b8', true),
  ('faberge', 6, 'Invisible Egg of Shadow', 4900, 'legendary', 2857, 1532389, 'bighead:#9aa3b8', true),
  ('faberge', 7, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 1786, 10351018, 'bighead:#9aa3b8', true),
  ('faberge', 8, 'Mick McCann', 21100, 'legendary', 1071, 23264604, 'bighead:#9aa3b8', true),
  ('faberge', 9, 'Viridian Hood', 41200, 'legendary', 536, 16954107, 'bighead:#9aa3b8', true),
  ('faberge', 10, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 179, 47597760, 'bighead:#9aa3b8', true),
  ('zombie-horde', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('zombie-horde', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('zombie-horde', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 99000, 24826811, 'bighead:#9aa3b8', false),
  ('zombie-horde', 3, 'Rusty Egg of Magnetism', 600, 'uncommon', 99000, 24826787, 'bighead:#9aa3b8', false),
  ('zombie-horde', 4, 'Racing Helmet', 900, 'rare', 99000, 6379764, 'bighead:#9aa3b8', false),
  ('zombie-horde', 5, 'Halloween Harbinger', 3300, 'legendary', 3571, 15727771, 'bighead:#9aa3b8', true),
  ('zombie-horde', 6, 'Halloween Santa Hat', 7100, 'legendary', 2857, 1173851, 'bighead:#9aa3b8', true),
  ('zombie-horde', 7, 'Camoface', 12000, 'legendary', 1786, 24441888, 'bighead:#9aa3b8', true),
  ('zombie-horde', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 1071, 20980122, 'bighead:#9aa3b8', true),
  ('zombie-horde', 9, 'The Crown of Nachos', 44100, 'legendary', 536, 22547617, 'bighead:#9aa3b8', true),
  ('zombie-horde', 10, 'Lava Reactor', 101800, 'legendary', 179, 32858948, 'bighead:#9aa3b8', true),
  ('haunted-patch', 0, 'POW! To the Moon! Egg', 400, 'uncommon', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('haunted-patch', 1, 'Specular Egg of Red, No Blue', 400, 'uncommon', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('haunted-patch', 2, 'Agonizingly Ugly Egg of Screensplat', 400, 'uncommon', 95000, 24826811, 'bighead:#9aa3b8', false),
  ('haunted-patch', 3, 'Guardia in Exile', 800, 'uncommon', 95000, 18174901, 'bighead:#9aa3b8', false),
  ('haunted-patch', 4, 'Stationary Egg of Boring', 1200, 'rare', 95000, 1530795, 'bighead:#9aa3b8', false),
  ('haunted-patch', 5, 'Blue Winter Cap', 3500, 'legendary', 15957, 1309918, 'bighead:#9aa3b8', true),
  ('haunted-patch', 6, 'Sci-Fi Santa', 4500, 'legendary', 12766, 18729820, 'bighead:#9aa3b8', true),
  ('haunted-patch', 7, 'Halloween Santa Hat', 7100, 'legendary', 10638, 1173851, 'bighead:#9aa3b8', true),
  ('haunted-patch', 8, 'Camoface', 12000, 'legendary', 6383, 24441888, 'bighead:#9aa3b8', true),
  ('haunted-patch', 9, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 3191, 1285300, 'bighead:#9aa3b8', true),
  ('haunted-patch', 10, 'The Crown of Nachos', 44100, 'legendary', 1064, 22547617, 'bighead:#9aa3b8', true),
  ('fiesta', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('fiesta', 1, 'Specular Egg of Red, No Blue', 400, 'common', 270000, 24826800, 'bighead:#9aa3b8', false),
  ('fiesta', 2, 'Rusty Egg of Magnetism', 600, 'uncommon', 90000, 24826787, 'bighead:#9aa3b8', false),
  ('fiesta', 3, 'Arctic Hood', 1000, 'uncommon', 90000, 18171366, 'bighead:#9aa3b8', false),
  ('fiesta', 4, 'Starry Egg of the Wild Ride', 1500, 'rare', 90000, 31151864, 'bighead:#9aa3b8', false),
  ('fiesta', 5, 'Gentlemen of Stratus', 4400, 'legendary', 31915, 34111862, 'bighead:#9aa3b8', true),
  ('fiesta', 6, 'Bloxxadore Domino Mask', 5200, 'legendary', 25532, 14492461, 'bighead:#9aa3b8', true),
  ('fiesta', 7, 'Black Paintball Mask', 6800, 'legendary', 21277, 9254521, 'bighead:#9aa3b8', true),
  ('fiesta', 8, '2010 Party Cap', 7100, 'legendary', 12766, 20044751, 'bighead:#9aa3b8', true),
  ('fiesta', 9, 'Black Iron Warhelm of Pwnage', 10200, 'legendary', 6383, 10351018, 'bighead:#9aa3b8', true),
  ('fiesta', 10, 'Bucket', 18000, 'legendary', 2128, 1081239, 'bighead:#9aa3b8', true),
  ('overgrown', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('overgrown', 1, 'Specular Egg of Red, No Blue', 400, 'common', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('overgrown', 2, 'Chaos Canyon Sugar Egg', 700, 'uncommon', 95000, 76692143, 'bighead:#9aa3b8', false),
  ('overgrown', 3, 'Turbo Builders Club Hard Hat', 1300, 'uncommon', 95000, 11844853, 'bighead:#9aa3b8', false),
  ('overgrown', 4, 'Blinking Egg of Relocation', 1800, 'rare', 95000, 1532381, 'bighead:#9aa3b8', false),
  ('overgrown', 5, 'Treehugger Visor', 5700, 'legendary', 15957, 9910514, 'bighead:#9aa3b8', true),
  ('overgrown', 6, 'Mandrake Root', 10400, 'legendary', 12766, 1191812, 'bighead:#9aa3b8', true),
  ('overgrown', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10638, 14817131, 'bighead:#9aa3b8', true),
  ('overgrown', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('overgrown', 9, 'Viridian Hood', 41200, 'legendary', 3191, 16954107, 'bighead:#9aa3b8', true),
  ('overgrown', 10, 'Lava Reactor', 101800, 'legendary', 1064, 32858948, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 1, 'Specular Egg of Red, No Blue', 400, 'common', 285000, 24826800, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 2, 'Guardia in Exile', 800, 'uncommon', 95000, 18174901, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 3, 'Starry Egg of the Wild Ride', 1500, 'uncommon', 95000, 31151864, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 4, '2009 Graduation Cap', 2300, 'rare', 95000, 11721340, 'bighead:#9aa3b8', false),
  ('dragon-hatch', 5, 'One Star General''s Beret', 6700, 'legendary', 15957, 28039679, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 6, 'Robosquid', 9200, 'legendary', 12766, 37238566, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 10638, 14817131, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 8, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 9, 'The Crown of Nachos', 44100, 'legendary', 3191, 22547617, 'bighead:#9aa3b8', true),
  ('dragon-hatch', 10, 'Playful Vampire', 90000, 'legendary', 1064, 2409285794, 'bighead:#9aa3b8', true),
  ('orbit', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('orbit', 1, 'Specular Egg of Red, No Blue', 400, 'common', 297000, 24826800, 'bighead:#9aa3b8', false),
  ('orbit', 2, 'Arctic Hood', 1000, 'uncommon', 99000, 18171366, 'bighead:#9aa3b8', false),
  ('orbit', 3, 'Christmas Baseball Cap', 2000, 'uncommon', 99000, 1272713, 'bighead:#9aa3b8', false),
  ('orbit', 4, 'The Moon', 2900, 'rare', 99000, 7319168, 'bighead:#9aa3b8', false),
  ('orbit', 5, 'Bag O'' Noobs', 11800, 'legendary', 3571, 32355759, 'bighead:#9aa3b8', true),
  ('orbit', 6, 'Seeing Stars', 18700, 'legendary', 2857, 27599954, 'bighead:#9aa3b8', true),
  ('orbit', 7, 'Viridian Hood', 41200, 'legendary', 1786, 16954107, 'bighead:#9aa3b8', true),
  ('orbit', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 1071, 47597760, 'bighead:#9aa3b8', true),
  ('orbit', 9, 'Super Super Happy Face', 162000, 'legendary', 536, 494291269, 'bighead:#9aa3b8', true),
  ('orbit', 10, 'Monstars Visor', 270000, 'legendary', 179, 1086815, 'bighead:#9aa3b8', true),
  ('martian', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('martian', 1, 'Chrome Egg of Speeding Bullet', 500, 'common', 270000, 24826640, 'bighead:#9aa3b8', false),
  ('martian', 2, 'Pink Penguin', 1400, 'uncommon', 90000, 16985920, 'bighead:#9aa3b8', false),
  ('martian', 3, 'Red Baseball Cap', 2500, 'uncommon', 90000, 1028606, 'bighead:#9aa3b8', false),
  ('martian', 4, 'Ultimate Slide Skateboard', 3700, 'rare', 90000, 52180878, 'bighead:#9aa3b8', false),
  ('martian', 5, 'Hollywood Sign', 11300, 'legendary', 31915, 17614445, 'bighead:#9aa3b8', true),
  ('martian', 6, 'Bag O'' Noobs', 11800, 'legendary', 25532, 32355759, 'bighead:#9aa3b8', true),
  ('martian', 7, 'Outlawed Vampumatiger Hybrid', 13800, 'legendary', 21277, 14817131, 'bighead:#9aa3b8', true),
  ('martian', 8, 'Bucket', 18000, 'legendary', 12766, 1081239, 'bighead:#9aa3b8', true),
  ('martian', 9, 'Burning Otaku, the Firesouled', 24600, 'legendary', 6383, 20980122, 'bighead:#9aa3b8', true),
  ('martian', 10, 'Viridian Hood', 41200, 'legendary', 2128, 16954107, 'bighead:#9aa3b8', true),
  ('blue-grin', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('blue-grin', 1, 'Chrome Egg of Speeding Bullet', 500, 'common', 285000, 24826640, 'bighead:#9aa3b8', false),
  ('blue-grin', 2, 'Starry Egg of the Wild Ride', 1500, 'uncommon', 95000, 31151864, 'bighead:#9aa3b8', false),
  ('blue-grin', 3, 'Puzzling Egg of Enigma', 2600, 'uncommon', 95000, 1532386, 'bighead:#9aa3b8', false),
  ('blue-grin', 4, 'Headrow', 3900, 'rare', 95000, 1082935, 'bighead:#9aa3b8', false),
  ('blue-grin', 5, 'Seeing Stars', 18700, 'legendary', 15957, 27599954, 'bighead:#9aa3b8', true),
  ('blue-grin', 6, 'Mick McCann', 21100, 'legendary', 12766, 23264604, 'bighead:#9aa3b8', true),
  ('blue-grin', 7, 'Hotdog Head', 35800, 'legendary', 10638, 15318156, 'bighead:#9aa3b8', true),
  ('blue-grin', 8, 'The Bluesteel Bathelm', 63000, 'legendary', 6383, 1172161, 'bighead:#9aa3b8', true),
  ('blue-grin', 9, 'Lava Reactor', 101800, 'legendary', 3191, 32858948, 'bighead:#9aa3b8', true),
  ('blue-grin', 10, 'The Ice Skull of Nevermoor', 180000, 'legendary', 1064, 6552254, 'bighead:#9aa3b8', true),
  ('gearhead', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('gearhead', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 285000, 76692143, 'bighead:#9aa3b8', false),
  ('gearhead', 2, 'Blinking Egg of Relocation', 1800, 'uncommon', 95000, 1532381, 'bighead:#9aa3b8', false),
  ('gearhead', 3, 'Halloween Harbinger', 3300, 'uncommon', 95000, 15727771, 'bighead:#9aa3b8', false),
  ('gearhead', 4, 'Invisible Egg of Shadow', 4900, 'rare', 95000, 1532389, 'bighead:#9aa3b8', false),
  ('gearhead', 5, 'Bucket', 18000, 'legendary', 15957, 1081239, 'bighead:#9aa3b8', true),
  ('gearhead', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12766, 20980122, 'bighead:#9aa3b8', true),
  ('gearhead', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('gearhead', 8, 'Wildcard', 65400, 'legendary', 6383, 38322996, 'bighead:#9aa3b8', true),
  ('gearhead', 9, 'Even Eviler Jester', 106700, 'legendary', 3191, 40893465, 'bighead:#9aa3b8', true),
  ('gearhead', 10, 'Monstars Visor', 270000, 'legendary', 1064, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('gilded-night', 1, 'Chaos Canyon Sugar Egg', 700, 'common', 297000, 76692143, 'bighead:#9aa3b8', false),
  ('gilded-night', 2, 'Blinking Egg of Relocation', 1800, 'uncommon', 99000, 1532381, 'bighead:#9aa3b8', false),
  ('gilded-night', 3, 'Halloween Harbinger', 3300, 'uncommon', 99000, 15727771, 'bighead:#9aa3b8', false),
  ('gilded-night', 4, 'The Viper Band', 5000, 'rare', 99000, 18482403, 'bighead:#9aa3b8', false),
  ('gilded-night', 5, 'Seeing Stars', 18700, 'legendary', 3571, 27599954, 'bighead:#9aa3b8', true),
  ('gilded-night', 6, 'Golden Headphones', 52700, 'legendary', 2857, 29051524, 'bighead:#9aa3b8', true),
  ('gilded-night', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 1786, 47597760, 'bighead:#9aa3b8', true),
  ('gilded-night', 8, 'Super Super Happy Face', 162000, 'legendary', 1071, 494291269, 'bighead:#9aa3b8', true),
  ('gilded-night', 9, 'Monstars Visor', 270000, 'legendary', 536, 1086815, 'bighead:#9aa3b8', true),
  ('gilded-night', 10, 'Valkyrie Helm', 540000, 'legendary', 179, 1365767, 'bighead:#9aa3b8', true),
  ('spooky-beats', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('spooky-beats', 1, 'Guardia in Exile', 800, 'common', 285000, 18174901, 'bighead:#9aa3b8', false),
  ('spooky-beats', 2, 'Bouncing Egg of Boing Boing', 2200, 'uncommon', 95000, 1532384, 'bighead:#9aa3b8', false),
  ('spooky-beats', 3, 'The Earth', 4100, 'uncommon', 95000, 10072631, 'bighead:#9aa3b8', false),
  ('spooky-beats', 4, 'Gold Buckle Capotain', 6200, 'rare', 95000, 5671970, 'bighead:#9aa3b8', false),
  ('spooky-beats', 5, 'Bucket', 18000, 'legendary', 15957, 1081239, 'bighead:#9aa3b8', true),
  ('spooky-beats', 6, 'Burning Otaku, the Firesouled', 24600, 'legendary', 12766, 20980122, 'bighead:#9aa3b8', true),
  ('spooky-beats', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('spooky-beats', 8, 'The Bluesteel Bathelm', 63000, 'legendary', 6383, 1172161, 'bighead:#9aa3b8', true),
  ('spooky-beats', 9, 'Even Eviler Jester', 106700, 'legendary', 3191, 40893465, 'bighead:#9aa3b8', true),
  ('spooky-beats', 10, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1064, 1073690, 'bighead:#9aa3b8', true),
  ('atlantis', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('atlantis', 1, 'Racing Helmet', 900, 'common', 270000, 6379764, 'bighead:#9aa3b8', false),
  ('atlantis', 2, 'Red Baseball Cap', 2500, 'uncommon', 90000, 1028606, 'bighead:#9aa3b8', false),
  ('atlantis', 3, 'Black Lightning', 4600, 'uncommon', 90000, 29532225, 'bighead:#9aa3b8', false),
  ('atlantis', 4, 'Black Paintball Mask', 6800, 'rare', 90000, 9254521, 'bighead:#9aa3b8', false),
  ('atlantis', 5, 'Mick McCann', 21100, 'legendary', 25532, 23264604, 'bighead:#9aa3b8', true),
  ('atlantis', 6, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 31915, 1285300, 'bighead:#9aa3b8', true),
  ('atlantis', 7, 'Burning Otaku, the Firesouled', 24600, 'legendary', 21277, 20980122, 'bighead:#9aa3b8', true),
  ('atlantis', 8, 'Hotdog Head', 35800, 'legendary', 12766, 15318156, 'bighead:#9aa3b8', true),
  ('atlantis', 9, 'The Crown of Nachos', 44100, 'legendary', 6383, 22547617, 'bighead:#9aa3b8', true),
  ('atlantis', 10, 'The Bluesteel Bathelm', 63000, 'legendary', 2128, 1172161, 'bighead:#9aa3b8', true),
  ('ember', 0, 'POW! To the Moon! Egg', 400, 'common', 360000, 24826737, 'bighead:#9aa3b8', false),
  ('ember', 1, 'Arctic Hood', 1000, 'common', 270000, 18171366, 'bighead:#9aa3b8', false),
  ('ember', 2, 'Target Hat', 2700, 'uncommon', 90000, 1051578, 'bighead:#9aa3b8', false),
  ('ember', 3, 'Invisible Egg of Shadow', 4900, 'uncommon', 90000, 1532389, 'bighead:#9aa3b8', false),
  ('ember', 4, 'White Witch Hat', 7300, 'rare', 90000, 5207053, 'bighead:#9aa3b8', false),
  ('ember', 5, 'Burning Otaku, the Firesouled', 24600, 'legendary', 31915, 20980122, 'bighead:#9aa3b8', true),
  ('ember', 6, 'Hotdog Head', 35800, 'legendary', 25532, 15318156, 'bighead:#9aa3b8', true),
  ('ember', 7, 'Viridian Hood', 41200, 'legendary', 21277, 16954107, 'bighead:#9aa3b8', true),
  ('ember', 8, 'Imagine', 41400, 'legendary', 12766, 30394316, 'bighead:#9aa3b8', true),
  ('ember', 9, 'Golden Headphones', 52700, 'legendary', 6383, 29051524, 'bighead:#9aa3b8', true),
  ('ember', 10, 'Lava Reactor', 101800, 'legendary', 2128, 32858948, 'bighead:#9aa3b8', true),
  ('topaz', 0, 'POW! To the Moon! Egg', 400, 'common', 380000, 24826737, 'bighead:#9aa3b8', false),
  ('topaz', 1, 'Arctic Hood', 1000, 'common', 285000, 18171366, 'bighead:#9aa3b8', false),
  ('topaz', 2, 'White Ninja Headband of the Unimpeachable Soul', 2800, 'uncommon', 95000, 11297746, 'bighead:#9aa3b8', false),
  ('topaz', 3, 'The Viper Band', 5000, 'uncommon', 95000, 18482403, 'bighead:#9aa3b8', false),
  ('topaz', 4, 'White Witch Hat', 7300, 'rare', 95000, 5207053, 'bighead:#9aa3b8', false),
  ('topaz', 5, 'Failed Proofs of the Riemann Hypothesis', 23100, 'legendary', 15957, 1285300, 'bighead:#9aa3b8', true),
  ('topaz', 6, 'The Crown of Nachos', 44100, 'legendary', 12766, 22547617, 'bighead:#9aa3b8', true),
  ('topaz', 7, 'Golden Headphones', 52700, 'legendary', 10638, 29051524, 'bighead:#9aa3b8', true),
  ('topaz', 8, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 6383, 47597760, 'bighead:#9aa3b8', true),
  ('topaz', 9, 'Super Super Happy Face', 162000, 'legendary', 3191, 494291269, 'bighead:#9aa3b8', true),
  ('topaz', 10, 'Monstars Visor', 270000, 'legendary', 1064, 1086815, 'bighead:#9aa3b8', true),
  ('tide-blade', 0, 'POW! To the Moon! Egg', 400, 'common', 396000, 24826737, 'bighead:#9aa3b8', false),
  ('tide-blade', 1, 'Stationary Egg of Boring', 1200, 'common', 297000, 1530795, 'bighead:#9aa3b8', false),
  ('tide-blade', 2, 'Halloween Harbinger', 3300, 'uncommon', 99000, 15727771, 'bighead:#9aa3b8', false),
  ('tide-blade', 3, 'Gold Buckle Capotain', 6200, 'uncommon', 99000, 5671970, 'bighead:#9aa3b8', false),
  ('tide-blade', 4, 'Robosquid', 9200, 'rare', 99000, 37238566, 'bighead:#9aa3b8', false),
  ('tide-blade', 5, 'Hotdog Head', 35800, 'legendary', 3571, 15318156, 'bighead:#9aa3b8', true),
  ('tide-blade', 6, 'Sword of the Winter Winds', 57600, 'legendary', 2857, 42847923, 'bighead:#9aa3b8', true),
  ('tide-blade', 7, 'Even Eviler Jester', 106700, 'legendary', 1786, 40893465, 'bighead:#9aa3b8', true),
  ('tide-blade', 8, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1071, 1073690, 'bighead:#9aa3b8', true),
  ('tide-blade', 9, 'Valkyrie Helm', 540000, 'legendary', 536, 1365767, 'bighead:#9aa3b8', true),
  ('tide-blade', 10, 'Spec Beta Biograft Energy Sword', 1260000, 'legendary', 179, 14876573, 'bighead:#9aa3b8', true),
  ('brass-samurai', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 380000, 24826640, 'bighead:#9aa3b8', false),
  ('brass-samurai', 1, 'Starry Egg of the Wild Ride', 1500, 'common', 285000, 31151864, 'bighead:#9aa3b8', false),
  ('brass-samurai', 2, 'Golden Egg of Kings', 4200, 'uncommon', 95000, 1532387, 'bighead:#9aa3b8', false),
  ('brass-samurai', 3, 'White Witch Hat', 7300, 'uncommon', 95000, 5207053, 'bighead:#9aa3b8', false),
  ('brass-samurai', 4, 'Hollywood Sign', 11300, 'rare', 95000, 17614445, 'bighead:#9aa3b8', false),
  ('brass-samurai', 5, 'Hotdog Head', 35800, 'legendary', 15957, 15318156, 'bighead:#9aa3b8', true),
  ('brass-samurai', 6, 'Golden Headphones', 52700, 'legendary', 12766, 29051524, 'bighead:#9aa3b8', true),
  ('brass-samurai', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 10638, 47597760, 'bighead:#9aa3b8', true),
  ('brass-samurai', 8, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('brass-samurai', 9, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3191, 1073690, 'bighead:#9aa3b8', true),
  ('brass-samurai', 10, 'Valkyrie Helm', 540000, 'legendary', 1064, 1365767, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 0, 'Chrome Egg of Speeding Bullet', 500, 'common', 380000, 24826640, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 1, 'Outrageous Builders Club Hard Hat', 1600, 'common', 285000, 17408283, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 2, 'Sci-Fi Santa', 4500, 'uncommon', 95000, 18729820, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 3, 'Das Deutschlandlied', 8400, 'uncommon', 95000, 26018282, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 4, 'Camoface', 12000, 'rare', 95000, 24441888, 'bighead:#9aa3b8', false),
  ('bubblegum-grin', 5, 'Bubble Trouble', 57600, 'legendary', 15957, 19264845, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 6, 'Sundae Best', 74600, 'legendary', 12766, 35685322, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 7, 'Lava Reactor', 101800, 'legendary', 10638, 32858948, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 8, 'Super Super Happy Face', 162000, 'legendary', 6383, 494291269, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 9, 'Monstars Visor', 270000, 'legendary', 3191, 1086815, 'bighead:#9aa3b8', true),
  ('bubblegum-grin', 10, 'Wanwood Antlers', 630000, 'legendary', 1064, 1272714, 'bighead:#9aa3b8', true),
  ('shogun', 0, 'Rusty Egg of Magnetism', 600, 'common', 380000, 24826787, 'bighead:#9aa3b8', false),
  ('shogun', 1, 'Christmas Baseball Cap', 2000, 'common', 285000, 1272713, 'bighead:#9aa3b8', false),
  ('shogun', 2, 'Ladies Who Lunch', 5600, 'uncommon', 95000, 35167841, 'bighead:#9aa3b8', false),
  ('shogun', 3, 'Black Iron Warhelm of Pwnage', 10200, 'uncommon', 95000, 10351018, 'bighead:#9aa3b8', false),
  ('shogun', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('shogun', 5, 'The Bluesteel Bathelm', 63000, 'legendary', 15957, 1172161, 'bighead:#9aa3b8', true),
  ('shogun', 6, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12766, 47597760, 'bighead:#9aa3b8', true),
  ('shogun', 7, 'Even Eviler Jester', 106700, 'legendary', 10638, 40893465, 'bighead:#9aa3b8', true),
  ('shogun', 8, 'Picklace', 192600, 'legendary', 6383, 33615415, 'bighead:#9aa3b8', true),
  ('shogun', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('shogun', 10, 'Helm of the Sacred Earth', 900000, 'legendary', 1064, 22157971, 'bighead:#9aa3b8', true),
  ('golden-snow', 0, 'Rusty Egg of Magnetism', 600, 'common', 380000, 24826787, 'bighead:#9aa3b8', false),
  ('golden-snow', 1, 'Kind Egg of Sharing', 2100, 'common', 285000, 1532395, 'bighead:#9aa3b8', false),
  ('golden-snow', 2, 'Santa Hat', 5800, 'uncommon', 95000, 1098277, 'bighead:#9aa3b8', false),
  ('golden-snow', 3, 'Mandrake Root', 10400, 'uncommon', 95000, 1191812, 'bighead:#9aa3b8', false),
  ('golden-snow', 4, 'Outlawed Vampumatiger Hybrid', 13800, 'rare', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('golden-snow', 5, 'Golden Headphones', 52700, 'legendary', 15957, 29051524, 'bighead:#9aa3b8', true),
  ('golden-snow', 6, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 12766, 47597760, 'bighead:#9aa3b8', true),
  ('golden-snow', 7, 'Even Eviler Jester', 106700, 'legendary', 10638, 40893465, 'bighead:#9aa3b8', true),
  ('golden-snow', 8, 'Korblox King', 168200, 'legendary', 6383, 52492417, 'bighead:#9aa3b8', true),
  ('golden-snow', 9, 'Monstars Visor', 270000, 'legendary', 3191, 1086815, 'bighead:#9aa3b8', true),
  ('golden-snow', 10, 'Wanwood Antlers', 630000, 'legendary', 1064, 1272714, 'bighead:#9aa3b8', true),
  ('frostbite', 0, 'Chaos Canyon Sugar Egg', 700, 'common', 396000, 76692143, 'bighead:#9aa3b8', false),
  ('frostbite', 1, 'Bouncing Egg of Boing Boing', 2200, 'common', 297000, 1532384, 'bighead:#9aa3b8', false),
  ('frostbite', 2, 'Gold Buckle Capotain', 6200, 'uncommon', 99000, 5671970, 'bighead:#9aa3b8', false),
  ('frostbite', 3, 'Ochre Ogre', 10900, 'uncommon', 99000, 16723499, 'bighead:#9aa3b8', false),
  ('frostbite', 4, 'Bucket', 18000, 'rare', 99000, 1081239, 'bighead:#9aa3b8', false),
  ('frostbite', 5, 'The Bluesteel Bathelm', 63000, 'legendary', 3571, 1172161, 'bighead:#9aa3b8', true),
  ('frostbite', 6, 'The Ice Skull of Nevermoor', 180000, 'legendary', 2857, 6552254, 'bighead:#9aa3b8', true),
  ('frostbite', 7, 'JJ5x5''s White Top Hat', 243000, 'legendary', 1786, 1073690, 'bighead:#9aa3b8', true),
  ('frostbite', 8, 'Valkyrie Helm', 540000, 'legendary', 1071, 1365767, 'bighead:#9aa3b8', true),
  ('frostbite', 9, 'Green Ice Crown', 954000, 'legendary', 536, 193696233, 'bighead:#9aa3b8', true),
  ('frostbite', 10, 'Hooded Frostlord', 1800000, 'legendary', 179, 136802867, 'bighead:#9aa3b8', true),
  ('pop-art', 0, 'Chaos Canyon Sugar Egg', 700, 'common', 360000, 76692143, 'bighead:#9aa3b8', false),
  ('pop-art', 1, '2009 Graduation Cap', 2300, 'common', 270000, 11721340, 'bighead:#9aa3b8', false),
  ('pop-art', 2, 'For the Ages: Abraham Lincoln', 6400, 'uncommon', 90000, 46363235, 'bighead:#9aa3b8', false),
  ('pop-art', 3, 'Hollywood Sign', 11300, 'uncommon', 90000, 17614445, 'bighead:#9aa3b8', false),
  ('pop-art', 4, 'Bucket', 18000, 'rare', 90000, 1081239, 'bighead:#9aa3b8', false),
  ('pop-art', 5, 'Wildcard', 65400, 'legendary', 31915, 38322996, 'bighead:#9aa3b8', true),
  ('pop-art', 6, 'Sundae Best', 74600, 'legendary', 25532, 35685322, 'bighead:#9aa3b8', true),
  ('pop-art', 7, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 21277, 47597760, 'bighead:#9aa3b8', true),
  ('pop-art', 8, 'Playful Vampire', 90000, 'legendary', 12766, 2409285794, 'bighead:#9aa3b8', true),
  ('pop-art', 9, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('pop-art', 10, 'Super Super Happy Face', 162000, 'legendary', 2128, 494291269, 'bighead:#9aa3b8', true),
  ('jurassic', 0, 'Guardia in Exile', 800, 'common', 360000, 18174901, 'bighead:#9aa3b8', false),
  ('jurassic', 1, 'Red Baseball Cap', 2500, 'common', 270000, 1028606, 'bighead:#9aa3b8', false),
  ('jurassic', 2, '2010 Party Cap', 7100, 'uncommon', 90000, 20044751, 'bighead:#9aa3b8', false),
  ('jurassic', 3, 'Kid Robot', 12500, 'uncommon', 90000, 29283299, 'bighead:#9aa3b8', false),
  ('jurassic', 4, 'Seeing Stars', 18700, 'rare', 90000, 27599954, 'bighead:#9aa3b8', false),
  ('jurassic', 5, 'Pin Head', 56100, 'legendary', 25532, 25880554, 'bighead:#9aa3b8', true),
  ('jurassic', 6, 'Bubble Trouble', 57600, 'legendary', 31915, 19264845, 'bighead:#9aa3b8', true),
  ('jurassic', 7, 'Sundae Best', 74600, 'legendary', 21277, 35685322, 'bighead:#9aa3b8', true),
  ('jurassic', 8, 'Playful Vampire', 90000, 'legendary', 12766, 2409285794, 'bighead:#9aa3b8', true),
  ('jurassic', 9, 'Even Eviler Jester', 106700, 'legendary', 6383, 40893465, 'bighead:#9aa3b8', true),
  ('jurassic', 10, 'Picklace', 192600, 'legendary', 2128, 33615415, 'bighead:#9aa3b8', true),
  ('midnight-holly', 0, 'Racing Helmet', 900, 'common', 380000, 6379764, 'bighead:#9aa3b8', false),
  ('midnight-holly', 1, 'The Moon', 2900, 'common', 285000, 7319168, 'bighead:#9aa3b8', false),
  ('midnight-holly', 2, 'Das Deutschlandlied', 8400, 'uncommon', 95000, 26018282, 'bighead:#9aa3b8', false),
  ('midnight-holly', 3, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('midnight-holly', 4, 'Mick McCann', 21100, 'rare', 95000, 23264604, 'bighead:#9aa3b8', false),
  ('midnight-holly', 5, 'Even Eviler Jester', 106700, 'legendary', 15957, 40893465, 'bighead:#9aa3b8', true),
  ('midnight-holly', 6, 'Super Super Happy Face', 162000, 'legendary', 12766, 494291269, 'bighead:#9aa3b8', true),
  ('midnight-holly', 7, 'Korblox King', 168200, 'legendary', 10638, 52492417, 'bighead:#9aa3b8', true),
  ('midnight-holly', 8, 'Monstars Visor', 270000, 'legendary', 6383, 1086815, 'bighead:#9aa3b8', true),
  ('midnight-holly', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('midnight-holly', 10, 'Pink Queen of the Night', 1026000, 'legendary', 1064, 553971558, 'bighead:#9aa3b8', true),
  ('viking-ember', 0, 'Arctic Hood', 1000, 'common', 380000, 18171366, 'bighead:#9aa3b8', false),
  ('viking-ember', 1, 'Blue Winter Cap', 3500, 'common', 285000, 1309918, 'bighead:#9aa3b8', false),
  ('viking-ember', 2, 'Cyborg Soldier', 9400, 'uncommon', 95000, 27052155, 'bighead:#9aa3b8', false),
  ('viking-ember', 3, 'Bucket', 18000, 'uncommon', 95000, 1081239, 'bighead:#9aa3b8', false),
  ('viking-ember', 4, 'Burning Otaku, the Firesouled', 24600, 'rare', 95000, 20980122, 'bighead:#9aa3b8', false),
  ('viking-ember', 5, 'Golden Chakram of the Sky Palace', 77000, 'legendary', 15957, 47597760, 'bighead:#9aa3b8', true),
  ('viking-ember', 6, 'Lava Reactor', 101800, 'legendary', 12766, 32858948, 'bighead:#9aa3b8', true),
  ('viking-ember', 7, 'Korblox King', 168200, 'legendary', 10638, 52492417, 'bighead:#9aa3b8', true),
  ('viking-ember', 8, 'Monstars Visor', 270000, 'legendary', 6383, 1086815, 'bighead:#9aa3b8', true),
  ('viking-ember', 9, 'Valkyrie Helm', 540000, 'legendary', 3191, 1365767, 'bighead:#9aa3b8', true),
  ('viking-ember', 10, 'Helm of the Sacred Earth', 900000, 'legendary', 1064, 22157971, 'bighead:#9aa3b8', true),
  ('nevermoor', 0, 'Starry Egg of the Wild Ride', 1500, 'common', 380000, 31151864, 'bighead:#9aa3b8', false),
  ('nevermoor', 1, 'The Viper Band', 5000, 'common', 285000, 18482403, 'bighead:#9aa3b8', false),
  ('nevermoor', 2, 'Outlawed Vampumatiger Hybrid', 13800, 'uncommon', 95000, 14817131, 'bighead:#9aa3b8', false),
  ('nevermoor', 3, 'Burning Otaku, the Firesouled', 24600, 'uncommon', 95000, 20980122, 'bighead:#9aa3b8', false),
  ('nevermoor', 4, 'Hotdog Head', 35800, 'rare', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('nevermoor', 5, 'Super Super Happy Face', 162000, 'legendary', 15957, 494291269, 'bighead:#9aa3b8', true),
  ('nevermoor', 6, 'The Ice Skull of Nevermoor', 180000, 'legendary', 12766, 6552254, 'bighead:#9aa3b8', true),
  ('nevermoor', 7, 'JJ5x5''s White Top Hat', 243000, 'legendary', 10638, 1073690, 'bighead:#9aa3b8', true),
  ('nevermoor', 8, 'Valkyrie Helm', 540000, 'legendary', 6383, 1365767, 'bighead:#9aa3b8', true),
  ('nevermoor', 9, 'Ice Valkyrie', 738000, 'legendary', 3191, 4390891467, 'bighead:#9aa3b8', true),
  ('nevermoor', 10, 'Hooded Frostlord', 1800000, 'legendary', 1064, 136802867, 'bighead:#9aa3b8', true),
  ('smiley', 0, 'Christmas Baseball Cap', 2000, 'common', 360000, 1272713, 'bighead:#9aa3b8', false),
  ('smiley', 1, 'For the Ages: Abraham Lincoln', 6400, 'common', 270000, 46363235, 'bighead:#9aa3b8', false),
  ('smiley', 2, 'Bucket', 18000, 'uncommon', 90000, 1081239, 'bighead:#9aa3b8', false),
  ('smiley', 3, 'Hotdog Head', 35800, 'uncommon', 90000, 15318156, 'bighead:#9aa3b8', false),
  ('smiley', 4, 'Golden Headphones', 52700, 'rare', 90000, 29051524, 'bighead:#9aa3b8', false),
  ('smiley', 5, 'Super Super Happy Face', 162000, 'legendary', 34091, 494291269, 'bighead:#9aa3b8', true),
  ('smiley', 6, 'Korblox King', 168200, 'legendary', 27273, 52492417, 'bighead:#9aa3b8', true),
  ('smiley', 7, 'The Ice Skull of Nevermoor', 180000, 'legendary', 22727, 6552254, 'bighead:#9aa3b8', true),
  ('smiley', 8, 'Monstars Visor', 270000, 'legendary', 13636, 1086815, 'bighead:#9aa3b8', true),
  ('smiley', 9, 'Valkyrie Helm', 540000, 'legendary', 2273, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 0, 'Christmas Baseball Cap', 2000, 'common', 380000, 1272713, 'bighead:#9aa3b8', false),
  ('tropical-pop', 1, 'Black Paintball Mask', 6800, 'common', 285000, 9254521, 'bighead:#9aa3b8', false),
  ('tropical-pop', 2, 'Seeing Stars', 18700, 'uncommon', 95000, 27599954, 'bighead:#9aa3b8', false),
  ('tropical-pop', 3, 'Hotdog Head', 35800, 'uncommon', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('tropical-pop', 4, 'Golden Headphones', 52700, 'rare', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('tropical-pop', 5, 'JJ5x5''s White Top Hat', 243000, 'legendary', 15957, 1073690, 'bighead:#9aa3b8', true),
  ('tropical-pop', 6, 'Monstars Visor', 270000, 'legendary', 12766, 1086815, 'bighead:#9aa3b8', true),
  ('tropical-pop', 7, 'Valkyrie Helm', 540000, 'legendary', 10638, 1365767, 'bighead:#9aa3b8', true),
  ('tropical-pop', 8, 'Wanwood Antlers', 630000, 'legendary', 6383, 1272714, 'bighead:#9aa3b8', true),
  ('tropical-pop', 9, 'Collision Top Hat', 990000, 'legendary', 3191, 158068251, 'bighead:#9aa3b8', true),
  ('tropical-pop', 10, 'Red Crown of Ozymandias', 1980000, 'legendary', 1064, 9465511, 'bighead:#9aa3b8', true),
  ('retro-wave', 0, 'Bouncing Egg of Boing Boing', 2200, 'common', 380000, 1532384, 'bighead:#9aa3b8', false),
  ('retro-wave', 1, 'Traffic Cone', 7200, 'common', 285000, 1082932, 'bighead:#9aa3b8', false),
  ('retro-wave', 2, 'Mick McCann', 21100, 'uncommon', 95000, 23264604, 'bighead:#9aa3b8', false),
  ('retro-wave', 3, 'Hotdog Head', 35800, 'uncommon', 95000, 15318156, 'bighead:#9aa3b8', false),
  ('retro-wave', 4, 'Golden Headphones', 52700, 'rare', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('retro-wave', 5, 'Monstars Visor', 270000, 'legendary', 21429, 1086815, 'bighead:#9aa3b8', true),
  ('retro-wave', 6, 'Valkyrie Helm', 540000, 'legendary', 14286, 1365767, 'bighead:#9aa3b8', true),
  ('retro-wave', 7, 'Glorious Purple Party Queen', 936000, 'legendary', 8571, 258184056, 'bighead:#9aa3b8', true),
  ('retro-wave', 8, 'Clockwork''s Headphones', 1440000, 'legendary', 4286, 1235488, 'bighead:#9aa3b8', true),
  ('retro-wave', 9, 'Retro 80s Headphones', 2520000, 'legendary', 1429, 29844011, 'bighead:#9aa3b8', true),
  ('eclipse', 0, '2009 Graduation Cap', 2300, 'common', 396000, 11721340, 'bighead:#9aa3b8', false),
  ('eclipse', 1, 'White Witch Hat', 7300, 'common', 297000, 5207053, 'bighead:#9aa3b8', false),
  ('eclipse', 2, 'Mick McCann', 21100, 'uncommon', 99000, 23264604, 'bighead:#9aa3b8', false),
  ('eclipse', 3, 'Hotdog Head', 35800, 'uncommon', 99000, 15318156, 'bighead:#9aa3b8', false),
  ('eclipse', 4, 'Pin Head', 56100, 'rare', 99000, 25880554, 'bighead:#9aa3b8', false),
  ('eclipse', 5, 'JJ5x5''s White Top Hat', 243000, 'legendary', 3571, 1073690, 'bighead:#9aa3b8', true),
  ('eclipse', 6, 'Valkyrie Helm', 540000, 'legendary', 2857, 1365767, 'bighead:#9aa3b8', true),
  ('eclipse', 7, 'Silver King of the Night', 846000, 'legendary', 1786, 439945661, 'bighead:#9aa3b8', true),
  ('eclipse', 8, 'Dark Cerulean Crown of Ozymandias', 1512000, 'legendary', 1071, 13370505, 'bighead:#9aa3b8', true),
  ('eclipse', 9, 'Crown of Om Nom Nom', 3060000, 'legendary', 536, 21070350, 'bighead:#9aa3b8', true),
  ('eclipse', 10, 'Gaze of Socom1880', 6120000, 'legendary', 179, 14671091, 'bighead:#9aa3b8', true),
  ('shadow-beats', 0, 'Halloween Harbinger', 3300, 'common', 396000, 15727771, 'bighead:#9aa3b8', false),
  ('shadow-beats', 1, 'Ochre Ogre', 10900, 'common', 297000, 16723499, 'bighead:#9aa3b8', false),
  ('shadow-beats', 2, 'Hotdog Head', 35800, 'uncommon', 99000, 15318156, 'bighead:#9aa3b8', false),
  ('shadow-beats', 3, 'Pin Head', 56100, 'uncommon', 99000, 25880554, 'bighead:#9aa3b8', false),
  ('shadow-beats', 4, 'Golden Chakram of the Sky Palace', 77000, 'rare', 99000, 47597760, 'bighead:#9aa3b8', false),
  ('shadow-beats', 5, 'Monstars Visor', 270000, 'legendary', 3571, 1086815, 'bighead:#9aa3b8', true),
  ('shadow-beats', 6, 'Silver King of the Night', 846000, 'legendary', 2857, 439945661, 'bighead:#9aa3b8', true),
  ('shadow-beats', 7, 'Pink Queen of the Night', 1026000, 'legendary', 1786, 553971558, 'bighead:#9aa3b8', true),
  ('shadow-beats', 8, 'Vaiobot''s Moneylicious Tie', 2250000, 'legendary', 1071, 30371876, 'bighead:#9aa3b8', true),
  ('shadow-beats', 9, 'Sword Cane', 4320000, 'legendary', 536, 25740034, 'bighead:#9aa3b8', true),
  ('shadow-beats', 10, 'Black Iron King of the Night', 10800000, 'legendary', 179, 439946249, 'bighead:#9aa3b8', true),
  ('arctic-moss', 0, 'Ladies Who Lunch', 5600, 'common', 380000, 35167841, 'bighead:#9aa3b8', false),
  ('arctic-moss', 1, 'Bucket', 18000, 'common', 285000, 1081239, 'bighead:#9aa3b8', false),
  ('arctic-moss', 2, 'Golden Headphones', 52700, 'uncommon', 95000, 29051524, 'bighead:#9aa3b8', false),
  ('arctic-moss', 3, 'Playful Vampire', 90000, 'uncommon', 95000, 2409285794, 'bighead:#9aa3b8', false),
  ('arctic-moss', 4, 'Super Super Happy Face', 162000, 'rare', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('arctic-moss', 5, 'Wanwood Antlers', 630000, 'legendary', 15957, 1272714, 'bighead:#9aa3b8', true),
  ('arctic-moss', 6, 'Ice Valkyrie', 738000, 'legendary', 12766, 4390891467, 'bighead:#9aa3b8', true),
  ('arctic-moss', 7, 'Green Ice Crown', 954000, 'legendary', 10638, 193696233, 'bighead:#9aa3b8', true),
  ('arctic-moss', 8, 'Helm of the Great Tree', 1350000, 'legendary', 6383, 9910420, 'bighead:#9aa3b8', true),
  ('arctic-moss', 9, 'Green Bow Tie', 2700000, 'legendary', 3191, 16598513, 'bighead:#9aa3b8', true),
  ('arctic-moss', 10, 'The Ice Crown', 7200000, 'legendary', 1064, 1323384, 'bighead:#9aa3b8', true),
  ('sunbeam', 0, 'One Star General''s Beret', 6700, 'common', 360000, 28039679, 'bighead:#9aa3b8', false),
  ('sunbeam', 1, 'Mick McCann', 21100, 'common', 270000, 23264604, 'bighead:#9aa3b8', false),
  ('sunbeam', 2, 'The Bluesteel Bathelm', 63000, 'uncommon', 90000, 1172161, 'bighead:#9aa3b8', false),
  ('sunbeam', 3, 'Even Eviler Jester', 106700, 'uncommon', 90000, 40893465, 'bighead:#9aa3b8', false),
  ('sunbeam', 4, 'Super Super Happy Face', 162000, 'rare', 90000, 494291269, 'bighead:#9aa3b8', false),
  ('sunbeam', 5, 'Valkyrie Helm', 540000, 'legendary', 31915, 1365767, 'bighead:#9aa3b8', true),
  ('sunbeam', 6, 'Ice Valkyrie', 738000, 'legendary', 25532, 4390891467, 'bighead:#9aa3b8', true),
  ('sunbeam', 7, 'Helm of the Sacred Earth', 900000, 'legendary', 21277, 22157971, 'bighead:#9aa3b8', true),
  ('sunbeam', 8, 'Goldlika: Hero', 936000, 'legendary', 12766, 323419455, 'bighead:#9aa3b8', true),
  ('sunbeam', 9, 'Headdress of Aken-Aten, the Sun King', 1080000, 'legendary', 6383, 18482398, 'bighead:#9aa3b8', true),
  ('sunbeam', 10, 'GoldLika: Troll', 1530000, 'legendary', 2128, 398674241, 'bighead:#9aa3b8', true),
  ('neon-pop', 0, 'Cyborg Soldier', 9400, 'common', 380000, 27052155, 'bighead:#9aa3b8', false),
  ('neon-pop', 1, 'Hotdog Head', 35800, 'common', 285000, 15318156, 'bighead:#9aa3b8', false),
  ('neon-pop', 2, 'Playful Vampire', 90000, 'uncommon', 95000, 2409285794, 'bighead:#9aa3b8', false),
  ('neon-pop', 3, 'Super Super Happy Face', 162000, 'uncommon', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('neon-pop', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 95000, 1073690, 'bighead:#9aa3b8', false),
  ('neon-pop', 5, 'Neon Purple Crazy Crown', 1116000, 'legendary', 15957, 376805769, 'bighead:#9aa3b8', true),
  ('neon-pop', 6, 'Crazy Glasses', 1350000, 'legendary', 12766, 16646369, 'bighead:#9aa3b8', true),
  ('neon-pop', 7, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 10638, 188888052, 'bighead:#9aa3b8', true),
  ('neon-pop', 8, 'Neon Green Crazy Crown', 2430000, 'legendary', 6383, 321346616, 'bighead:#9aa3b8', true),
  ('neon-pop', 9, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 3191, 315549204, 'bighead:#9aa3b8', true),
  ('neon-pop', 10, '): Red Grind', 11700000, 'legendary', 1064, 20573086, 'bighead:#9aa3b8', true),
  ('crystal-beats', 0, 'Cyborg Soldier', 9400, 'common', 396000, 27052155, 'bighead:#9aa3b8', false),
  ('crystal-beats', 1, 'Hotdog Head', 35800, 'common', 297000, 15318156, 'bighead:#9aa3b8', false),
  ('crystal-beats', 2, 'Playful Vampire', 90000, 'uncommon', 99000, 2409285794, 'bighead:#9aa3b8', false),
  ('crystal-beats', 3, 'Super Super Happy Face', 162000, 'uncommon', 99000, 494291269, 'bighead:#9aa3b8', false),
  ('crystal-beats', 4, 'JJ5x5''s White Top Hat', 243000, 'rare', 99000, 1073690, 'bighead:#9aa3b8', false),
  ('crystal-beats', 5, 'Green Ice Crown', 954000, 'legendary', 3571, 193696233, 'bighead:#9aa3b8', true),
  ('crystal-beats', 6, 'Retro 80s Headphones', 2520000, 'legendary', 2857, 29844011, 'bighead:#9aa3b8', true),
  ('crystal-beats', 7, 'Yellow Glowing Eyes', 3240000, 'legendary', 1786, 416846000, 'bighead:#9aa3b8', true),
  ('crystal-beats', 8, 'WC Ultimates: Pink Diamond Distraction', 6300000, 'legendary', 1071, 315549204, 'bighead:#9aa3b8', true),
  ('crystal-beats', 9, 'WC Ultimates: Aquamarine Attitude', 17100000, 'legendary', 536, 323417812, 'bighead:#9aa3b8', true),
  ('crystal-beats', 10, 'Eerie Pumpkin Head', 36000000, 'legendary', 179, 1158416, 'bighead:#9aa3b8', true),
  ('lime-grin', 0, 'Camoface', 12000, 'common', 380000, 24441888, 'bighead:#9aa3b8', false),
  ('lime-grin', 1, 'Viridian Hood', 41200, 'common', 285000, 16954107, 'bighead:#9aa3b8', false),
  ('lime-grin', 2, 'Even Eviler Jester', 106700, 'uncommon', 95000, 40893465, 'bighead:#9aa3b8', false),
  ('lime-grin', 3, 'Picklace', 192600, 'uncommon', 95000, 33615415, 'bighead:#9aa3b8', false),
  ('lime-grin', 4, 'Monstars Visor', 270000, 'rare', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('lime-grin', 5, 'Clockwork''s Headphones', 1440000, 'legendary', 15957, 1235488, 'bighead:#9aa3b8', true),
  ('lime-grin', 6, 'GoldLika: Troll', 1530000, 'legendary', 12766, 398674241, 'bighead:#9aa3b8', true),
  ('lime-grin', 7, 'Neon Green Crazy Crown', 2430000, 'legendary', 10638, 321346616, 'bighead:#9aa3b8', true),
  ('lime-grin', 8, 'Yellow Glowing Eyes', 3240000, 'legendary', 6383, 416846000, 'bighead:#9aa3b8', true),
  ('lime-grin', 9, 'Gaze of Socom1880', 6120000, 'legendary', 3191, 14671091, 'bighead:#9aa3b8', true),
  ('lime-grin', 10, '): Red Grind', 11700000, 'legendary', 1064, 20573086, 'bighead:#9aa3b8', true),
  ('mistletoe', 0, 'Bucket', 18000, 'common', 360000, 1081239, 'bighead:#9aa3b8', false),
  ('mistletoe', 1, 'Golden Headphones', 52700, 'common', 270000, 29051524, 'bighead:#9aa3b8', false),
  ('mistletoe', 2, 'Super Super Happy Face', 162000, 'uncommon', 90000, 494291269, 'bighead:#9aa3b8', false),
  ('mistletoe', 3, 'Monstars Visor', 270000, 'uncommon', 90000, 1086815, 'bighead:#9aa3b8', false),
  ('mistletoe', 4, 'Valkyrie Helm', 540000, 'rare', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('mistletoe', 5, 'Fancy St. Patrick''s Fedora', 1350000, 'legendary', 31915, 149594212, 'bighead:#9aa3b8', true),
  ('mistletoe', 6, 'Immortal Sword: Endless Ice Slasher', 1800000, 'legendary', 25532, 568920951, 'bighead:#9aa3b8', true),
  ('mistletoe', 7, 'CW Ultimate: Sapphire Serenity', 1890000, 'legendary', 21277, 188888052, 'bighead:#9aa3b8', true),
  ('mistletoe', 8, 'Neon Green Crazy Crown', 2430000, 'legendary', 12766, 321346616, 'bighead:#9aa3b8', true),
  ('mistletoe', 9, 'Green Bow Tie', 2700000, 'legendary', 6383, 16598513, 'bighead:#9aa3b8', true),
  ('mistletoe', 10, 'Sparkle Time Fedora', 4500000, 'legendary', 2128, 1285307, 'bighead:#9aa3b8', true),
  ('winter-crown', 0, 'Bucket', 18000, 'common', 380000, 1081239, 'bighead:#9aa3b8', false),
  ('winter-crown', 1, 'Pin Head', 56100, 'common', 285000, 25880554, 'bighead:#9aa3b8', false),
  ('winter-crown', 2, 'Super Super Happy Face', 162000, 'uncommon', 95000, 494291269, 'bighead:#9aa3b8', false),
  ('winter-crown', 3, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('winter-crown', 4, 'Valkyrie Helm', 540000, 'rare', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('winter-crown', 5, 'Red Crown of Ozymandias', 1980000, 'legendary', 15957, 9465511, 'bighead:#9aa3b8', true),
  ('winter-crown', 6, 'Neon Green Crazy Crown', 2430000, 'legendary', 12766, 321346616, 'bighead:#9aa3b8', true),
  ('winter-crown', 7, 'Crown of Om Nom Nom', 3060000, 'legendary', 10638, 21070350, 'bighead:#9aa3b8', true),
  ('winter-crown', 8, 'The Void Star', 5580000, 'legendary', 6383, 1125510, 'bighead:#9aa3b8', true),
  ('winter-crown', 9, 'Black Iron King of the Night', 10800000, 'legendary', 3191, 439946249, 'bighead:#9aa3b8', true),
  ('winter-crown', 10, 'Darkheart', 21600000, 'legendary', 1064, 16895215, 'bighead:#9aa3b8', true),
  ('violet-beats', 0, 'Hotdog Head', 35800, 'common', 360000, 15318156, 'bighead:#9aa3b8', false),
  ('violet-beats', 1, 'Lava Reactor', 101800, 'common', 270000, 32858948, 'bighead:#9aa3b8', false),
  ('violet-beats', 2, 'Monstars Visor', 270000, 'uncommon', 90000, 1086815, 'bighead:#9aa3b8', false),
  ('violet-beats', 3, 'Valkyrie Helm', 540000, 'uncommon', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('violet-beats', 4, 'Ice Valkyrie', 738000, 'rare', 90000, 4390891467, 'bighead:#9aa3b8', false),
  ('violet-beats', 5, 'CW Ultimate: Amethyst Addiction', 2520000, 'legendary', 31915, 188004500, 'bighead:#9aa3b8', true),
  ('violet-beats', 6, 'Crown of the Undead Hoard', 2610000, 'legendary', 25532, 31046644, 'bighead:#9aa3b8', true),
  ('violet-beats', 7, 'Chrononoctis: The Ominous Helm', 2790000, 'legendary', 21277, 161211371, 'bighead:#9aa3b8', true),
  ('violet-beats', 8, 'CW Ultimate: Rose Quartz Rebellion', 3600000, 'legendary', 12766, 228449574, 'bighead:#9aa3b8', true),
  ('violet-beats', 9, 'Steampunk Aetherspectacles', 4860000, 'legendary', 6383, 12908119, 'bighead:#9aa3b8', true),
  ('violet-beats', 10, 'Dominus Rex', 7920000, 'legendary', 2128, 250395631, 'bighead:#9aa3b8', true),
  ('glacier', 0, 'Hotdog Head', 35800, 'common', 380000, 15318156, 'bighead:#9aa3b8', false),
  ('glacier', 1, 'Lava Reactor', 101800, 'common', 285000, 32858948, 'bighead:#9aa3b8', false),
  ('glacier', 2, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('glacier', 3, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('glacier', 4, 'Ice Valkyrie', 738000, 'rare', 95000, 4390891467, 'bighead:#9aa3b8', false),
  ('glacier', 5, 'Frozen Horns of the Frigid Planes', 3600000, 'legendary', 15957, 74891470, 'bighead:#9aa3b8', true),
  ('glacier', 6, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 12766, 215718515, 'bighead:#9aa3b8', true),
  ('glacier', 7, 'Steampunk Aetherspectacles', 4860000, 'legendary', 10638, 12908119, 'bighead:#9aa3b8', true),
  ('glacier', 8, 'The Ice Crown', 7200000, 'legendary', 6383, 1323384, 'bighead:#9aa3b8', true),
  ('glacier', 9, 'The Wanwood Crown', 14400000, 'legendary', 3191, 9910070, 'bighead:#9aa3b8', true),
  ('glacier', 10, 'Eerie Pumpkin Head', 36000000, 'legendary', 1064, 1158416, 'bighead:#9aa3b8', true),
  ('evergreen', 0, 'Hotdog Head', 35800, 'common', 380000, 15318156, 'bighead:#9aa3b8', false),
  ('evergreen', 1, 'Lava Reactor', 101800, 'common', 285000, 32858948, 'bighead:#9aa3b8', false),
  ('evergreen', 2, 'Monstars Visor', 270000, 'uncommon', 95000, 1086815, 'bighead:#9aa3b8', false),
  ('evergreen', 3, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('evergreen', 4, 'Ice Valkyrie', 738000, 'rare', 95000, 4390891467, 'bighead:#9aa3b8', false),
  ('evergreen', 5, 'Green Glowing Eyes', 3780000, 'legendary', 15957, 398676450, 'bighead:#9aa3b8', true),
  ('evergreen', 6, 'CW Ultimate: Emerald Entropy', 4320000, 'legendary', 12766, 271015154, 'bighead:#9aa3b8', true),
  ('evergreen', 7, 'Gaze of Socom1880', 6120000, 'legendary', 10638, 14671091, 'bighead:#9aa3b8', true),
  ('evergreen', 8, 'Red Glowing Eyes', 8280000, 'legendary', 6383, 180660043, 'bighead:#9aa3b8', true),
  ('evergreen', 9, 'Bluesteel Bling $$ Necklace', 18900000, 'legendary', 3191, 489196035, 'bighead:#9aa3b8', true),
  ('evergreen', 10, 'Domino Crown', 43200000, 'legendary', 1064, 1031429, 'bighead:#9aa3b8', true),
  ('fire-ice', 0, 'The Crown of Nachos', 44100, 'common', 360000, 22547617, 'bighead:#9aa3b8', false),
  ('fire-ice', 1, 'Super Super Happy Face', 162000, 'common', 270000, 494291269, 'bighead:#9aa3b8', false),
  ('fire-ice', 2, 'Valkyrie Helm', 540000, 'uncommon', 90000, 1365767, 'bighead:#9aa3b8', false),
  ('fire-ice', 3, 'Silver King of the Night', 846000, 'uncommon', 90000, 439945661, 'bighead:#9aa3b8', false),
  ('fire-ice', 4, 'Crown of Tones', 1188000, 'rare', 90000, 152173424, 'bighead:#9aa3b8', false),
  ('fire-ice', 5, 'Fiery Horns of the Netherworld', 3960000, 'legendary', 31915, 215718515, 'bighead:#9aa3b8', true),
  ('fire-ice', 6, ':( Front Stand', 4050000, 'legendary', 25532, 321346550, 'bighead:#9aa3b8', true),
  ('fire-ice', 7, 'Sparkle Time Fedora', 4500000, 'legendary', 21277, 1285307, 'bighead:#9aa3b8', true),
  ('fire-ice', 8, 'The Ice Crown', 7200000, 'legendary', 12766, 1323384, 'bighead:#9aa3b8', true),
  ('fire-ice', 9, 'Red Glowing Eyes', 8280000, 'legendary', 6383, 180660043, 'bighead:#9aa3b8', true),
  ('fire-ice', 10, '): Red Grind', 11700000, 'legendary', 2128, 20573086, 'bighead:#9aa3b8', true),
  ('black-ice', 0, 'Golden Headphones', 52700, 'common', 380000, 29051524, 'bighead:#9aa3b8', false),
  ('black-ice', 1, 'Korblox King', 168200, 'common', 285000, 52492417, 'bighead:#9aa3b8', false),
  ('black-ice', 2, 'Valkyrie Helm', 540000, 'uncommon', 95000, 1365767, 'bighead:#9aa3b8', false),
  ('black-ice', 3, 'Silver King of the Night', 846000, 'uncommon', 95000, 439945661, 'bighead:#9aa3b8', false),
  ('black-ice', 4, 'Spec Beta Biograft Energy Sword', 1260000, 'rare', 95000, 14876573, 'bighead:#9aa3b8', false),
  ('black-ice', 5, 'Green Glowing Eyes', 3780000, 'legendary', 15957, 398676450, 'bighead:#9aa3b8', true),
  ('black-ice', 6, 'The Ice Crown', 7200000, 'legendary', 12766, 1323384, 'bighead:#9aa3b8', true),
  ('black-ice', 7, 'Black Iron King of the Night', 10800000, 'legendary', 10638, 439946249, 'bighead:#9aa3b8', true),
  ('black-ice', 8, 'The Crown of Roses', 13500000, 'legendary', 6383, 17449820, 'bighead:#9aa3b8', true),
  ('black-ice', 9, 'Darkheart', 21600000, 'legendary', 3191, 16895215, 'bighead:#9aa3b8', true),
  ('black-ice', 10, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1064, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 0, 'Playful Vampire', 90000, 'common', 396000, 2409285794, 'bighead:#9aa3b8', false),
  ('amethyst', 1, 'Monstars Visor', 270000, 'common', 297000, 1086815, 'bighead:#9aa3b8', false),
  ('amethyst', 2, 'Ice Valkyrie', 738000, 'uncommon', 99000, 4390891467, 'bighead:#9aa3b8', false),
  ('amethyst', 3, 'Dominus Praefectus', 1422000, 'uncommon', 99000, 527365852, 'bighead:#9aa3b8', false),
  ('amethyst', 4, 'Red Crown of Ozymandias', 1980000, 'rare', 99000, 9465511, 'bighead:#9aa3b8', false),
  ('amethyst', 5, 'Countess of the Federation', 9000000, 'legendary', 3571, 188003914, 'bighead:#9aa3b8', true),
  ('amethyst', 6, 'Orange Sparkle Time Fedora', 17100000, 'legendary', 2857, 215751161, 'bighead:#9aa3b8', true),
  ('amethyst', 7, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 1786, 63043890, 'bighead:#9aa3b8', true),
  ('amethyst', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 1071, 259423244, 'bighead:#9aa3b8', true),
  ('amethyst', 9, 'Dominus Astra', 108000000, 'legendary', 536, 162067148, 'bighead:#9aa3b8', true),
  ('amethyst', 10, 'Dominus Empyreus', 198000000, 'legendary', 179, 21070012, 'bighead:#9aa3b8', true),
  ('jade', 0, 'Super Super Happy Face', 162000, 'common', 380000, 494291269, 'bighead:#9aa3b8', false),
  ('jade', 1, 'Valkyrie Helm', 540000, 'common', 285000, 1365767, 'bighead:#9aa3b8', false),
  ('jade', 2, 'Dominus Praefectus', 1422000, 'uncommon', 95000, 527365852, 'bighead:#9aa3b8', false),
  ('jade', 3, 'Clockwork''s Shades', 2520000, 'uncommon', 95000, 11748356, 'bighead:#9aa3b8', false),
  ('jade', 4, 'Green Glowing Eyes', 3780000, 'rare', 95000, 398676450, 'bighead:#9aa3b8', false),
  ('jade', 5, 'Teal Sparkle Time Fedora', 18000000, 'legendary', 15957, 147180077, 'bighead:#9aa3b8', true),
  ('jade', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12766, 493476042, 'bighead:#9aa3b8', true),
  ('jade', 7, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 10638, 63043890, 'bighead:#9aa3b8', true),
  ('jade', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6383, 259423244, 'bighead:#9aa3b8', true),
  ('jade', 9, 'Dominus Astra', 108000000, 'legendary', 3191, 162067148, 'bighead:#9aa3b8', true),
  ('jade', 10, 'Dominus Empyreus', 198000000, 'legendary', 1064, 21070012, 'bighead:#9aa3b8', true),
  ('sapphire', 0, 'Picklace', 192600, 'common', 360000, 33615415, 'bighead:#9aa3b8', false),
  ('sapphire', 1, 'Wanwood Antlers', 630000, 'common', 270000, 1272714, 'bighead:#9aa3b8', false),
  ('sapphire', 2, 'Hooded Frostlord', 1800000, 'uncommon', 90000, 136802867, 'bighead:#9aa3b8', false),
  ('sapphire', 3, 'Cultural Item', 3240000, 'uncommon', 90000, 14462955, 'bighead:#9aa3b8', false),
  ('sapphire', 4, 'Steampunk Aetherspectacles', 4860000, 'rare', 90000, 12908119, 'bighead:#9aa3b8', false),
  ('sapphire', 5, 'Archduke of the Federation', 14400000, 'legendary', 31915, 293316452, 'bighead:#9aa3b8', true),
  ('sapphire', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 25532, 493476042, 'bighead:#9aa3b8', true),
  ('sapphire', 7, '): Euro 180', 22500000, 'legendary', 21277, 23705521, 'bighead:#9aa3b8', true),
  ('sapphire', 8, 'Purple Sparkle Time Fedora', 36000000, 'legendary', 12766, 63043890, 'bighead:#9aa3b8', true),
  ('sapphire', 9, 'Domino Crown', 43200000, 'legendary', 6383, 1031429, 'bighead:#9aa3b8', true),
  ('sapphire', 10, 'Black Sparkle Time Fedora', 45000000, 'legendary', 2128, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 0, 'JJ5x5''s White Top Hat', 243000, 'common', 380000, 1073690, 'bighead:#9aa3b8', false),
  ('sunset-remix', 1, 'Ice Valkyrie', 738000, 'common', 285000, 4390891467, 'bighead:#9aa3b8', false),
  ('sunset-remix', 2, 'Vaiobot''s Moneylicious Tie', 2250000, 'uncommon', 95000, 30371876, 'bighead:#9aa3b8', false),
  ('sunset-remix', 3, 'Green Glowing Eyes', 3780000, 'uncommon', 95000, 398676450, 'bighead:#9aa3b8', false),
  ('sunset-remix', 4, 'The Void Star', 5580000, 'rare', 95000, 1125510, 'bighead:#9aa3b8', false),
  ('sunset-remix', 5, 'Dominus Pittacium', 17100000, 'legendary', 15957, 335080779, 'bighead:#9aa3b8', true),
  ('sunset-remix', 6, 'Sky Blue Sparkle Time Fedora', 21600000, 'legendary', 12766, 493476042, 'bighead:#9aa3b8', true),
  ('sunset-remix', 7, 'Domino Crown', 43200000, 'legendary', 10638, 1031429, 'bighead:#9aa3b8', true),
  ('sunset-remix', 8, 'Black Sparkle Time Fedora', 45000000, 'legendary', 6383, 259423244, 'bighead:#9aa3b8', true),
  ('sunset-remix', 9, 'Dominus Astra', 108000000, 'legendary', 3191, 162067148, 'bighead:#9aa3b8', true),
  ('sunset-remix', 10, 'Dominus Empyreus', 198000000, 'legendary', 1064, 21070012, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 0, 'Silver King of the Night', 846000, 'common', 360000, 439945661, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 1, 'Chrononoctis: The Ominous Helm', 2790000, 'common', 270000, 161211371, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 2, 'Dominus Rex', 7920000, 'uncommon', 90000, 250395631, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 3, 'The Wanwood Crown', 14400000, 'uncommon', 90000, 9910070, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 4, 'Darkheart', 21600000, 'rare', 90000, 16895215, 'bighead:#9aa3b8', false),
  ('ultimate-grin', 5, 'Dominus Astra', 108000000, 'legendary', 41380, 162067148, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 6, 'Dominus Infernus', 126000000, 'legendary', 34482, 31101391, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 7, 'Dominus Frigidus', 162000000, 'legendary', 20689, 48545806, 'bighead:#9aa3b8', true),
  ('ultimate-grin', 8, 'Dominus Empyreus', 198000000, 'legendary', 3449, 21070012, 'bighead:#9aa3b8', true);

-- =====================================================================
-- Included: update 14 (provably fair)
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

-- =====================================================================
-- Included: update 15 (fair next seed, safety, crazy+jackpot, random bots)
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
