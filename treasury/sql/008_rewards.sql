create table if not exists levels(level int primary key,xp bigint not null);
create table if not exists reward_packs(level int primary key,name text not null);
create table if not exists reward_pack_items(level int references reward_packs,idx int,item_id bigint references upgrade_items,weight int,primary key(level,idx));
create table if not exists reward_claims(user_id uuid references users(id) on delete cascade,level int references reward_packs,claimed_at timestamptz not null,primary key(user_id,level));
alter table users add column if not exists catalog_wagered numeric(78,0) not null default 0;
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
  (100, 5, 259423244, 20) on conflict(level,idx) do nothing;
