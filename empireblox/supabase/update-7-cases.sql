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
