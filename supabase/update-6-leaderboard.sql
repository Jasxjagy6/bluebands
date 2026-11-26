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
