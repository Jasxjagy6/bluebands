-- =====================================================================
-- EmpireBlox update 8
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- If Supabase asks about RLS, choose "Run without RLS" (this file sets it up itself).
-- Keeps all players, coins and history.
--
--  • 120 cheaper limiteds added (cases + Upgrader + Rewards can use them)
--  • Cases rebalanced: cheap items now go far below the price; still 5% edge,
--    best pull ≈ 3.6× the price, gold dice 3%
--  • Rewards: 99.2% low pulls, 0.6% good item, 0.2% best item
--  • Blackjack: classic payouts — wins pay 1 to 1, blackjack pays 3 to 2
--  • Admin tools (Emperor is made admin)
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
