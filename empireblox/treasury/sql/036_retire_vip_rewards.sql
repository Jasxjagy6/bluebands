-- Retire the old crypto/USD Bronze-through-Amethyst bonus program without
-- deleting its payouts, claims, journals or historical valuation evidence.
create function reject_retired_vip_claim() returns trigger language plpgsql as $$
begin
  raise exception 'The old VIP bonus program is retired. Use daily coin rewards.' using errcode='23514';
end $$;
create trigger retired_vip_claim before insert on vip_claims for each row execute function reject_retired_vip_claim();

-- The daily packs keep their original level keys, item odds and coin values.
-- Their presentation belongs to the new winter collection, not the old VIP tiers.
update reward_packs p set name=w.name from (values
  (10,'Snowfall Pack'),(20,'Frostbite Pack'),(30,'Icebound Pack'),(40,'Glacier Pack'),(50,'Aurora Pack'),
  (60,'Evergreen Pack'),(70,'Crystal Pack'),(80,'Arctic Pack'),(90,'Midnight Pack'),(100,'Solstice Pack')
) w(level,name) where p.level=w.level;

alter table assets add constraint coin_denomination_fixed
check(id<>'COINS' or (symbol='COINS' and kind='ledger' and decimals=18 and token_address is null));
