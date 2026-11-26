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
