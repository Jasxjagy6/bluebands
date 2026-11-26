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
