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
