alter table users add column suspended_until timestamptz;
create function player_active(banned boolean, until_time timestamptz) returns boolean language sql stable as $$
  select not banned and (until_time is null or until_time<=now())
$$;
create table player_admin_actions(
  id uuid primary key, user_id uuid not null references users(id), actor_id bigint not null references admin_users(id),
  action text not null, reason text not null, details jsonb not null, journal_id bigint references journals(id),
  created_at timestamptz not null default now()
);
create index player_admin_history on player_admin_actions(user_id,created_at desc);
alter table deposits add column review_hold boolean not null default false;
alter table withdrawals drop constraint withdrawals_status_check;
alter table withdrawals add check(status in('requested','reviewing','approved','cancelled','sent'));
alter table withdrawals add column updated_at timestamptz;
create index withdrawals_approved on withdrawals(created_at) where status='approved';

create table vip_levels(
  level integer primary key, tier text not null, rank text not null, symbol text not null,
  threshold_usd integer not null unique check(threshold_usd>0), bonus_usdt numeric(10,2) not null check(bonus_usdt>0)
);
insert into vip_levels values
(1,'Bronze','I','🥉',100,1.00),
(2,'Bronze','II','🥉',500,2.00),
(3,'Bronze','III','🥉',1000,2.50),
(4,'Bronze','IV','🥉',2500,7.50),
(5,'Bronze','V','🥉',5000,12.50),
(6,'Silver','I','🥈',10000,25.00),
(7,'Silver','II','🥈',15200,26.00),
(8,'Silver','III','🥈',20500,26.50),
(9,'Silver','IV','🥈',26000,27.50),
(10,'Silver','V','🥈',32000,30.00),
(11,'Gold','I','🥇',39000,35.00),
(12,'Gold','II','🥇',48000,45.00),
(13,'Gold','III','🥇',58000,50.00),
(14,'Gold','IV','🥇',69000,55.00),
(15,'Gold','V','🥇',81000,60.00),
(16,'Platinum','I','🎖️',94000,65.00),
(17,'Platinum','II','🎖️',107500,67.50),
(18,'Platinum','III','🎖️',122000,72.50),
(19,'Platinum','IV','🎖️',138000,80.00),
(20,'Platinum','V','🎖️',155000,85.00),
(21,'Diamond','I','💎',173000,90.00),
(22,'Diamond','II','💎',192000,95.00),
(23,'Diamond','III','💎',211500,97.50),
(24,'Diamond','IV','💎',232000,102.00),
(25,'Diamond','V','💎',253000,105.00),
(26,'Emerald','I','💚',275000,110.00),
(27,'Emerald','II','💚',298000,115.00),
(28,'Emerald','III','💚',322000,120.00),
(29,'Emerald','IV','💚',347000,125.00),
(30,'Emerald','V','💚',373000,130.00),
(31,'Ruby','I','❤️',400000,135.00),
(32,'Ruby','II','❤️',428000,140.00),
(33,'Ruby','III','❤️',457000,145.00),
(34,'Ruby','IV','❤️',487000,150.00),
(35,'Ruby','V','❤️',518000,155.00),
(36,'Sapphire','I','💙',550000,160.00),
(37,'Sapphire','II','💙',583000,165.00),
(38,'Sapphire','III','💙',617000,170.00),
(39,'Sapphire','IV','💙',652000,175.00),
(40,'Sapphire','V','💙',688000,180.00),
(41,'Amethyst','I','💜',725000,185.00),
(42,'Amethyst','II','💜',763000,190.00),
(43,'Amethyst','III','💜',802000,195.00),
(44,'Amethyst','IV','💜',842000,200.00),
(45,'Amethyst','V','💜',883000,205.00);
create table vip_claims(
  user_id uuid references users(id),level integer references vip_levels(level),journal_id bigint not null references journals(id),
  claimed_at timestamptz not null default now(),primary key(user_id,level)
);
alter table game_quotes add column minor_per_usd numeric check(minor_per_usd>0);
alter table mines_rounds add column minor_per_usd numeric check(minor_per_usd>0);
alter table blackjack_rounds add column minor_per_usd numeric check(minor_per_usd>0);
alter table battles add column minor_per_usd numeric check(minor_per_usd>0);
alter table instant_rounds add column minor_per_usd numeric check(minor_per_usd>0);

-- Frozen valuation of settled stakes. Legacy priced entries can use their recorded
-- catalog unit or an archived quote that was valid when the player entered.
create view vip_wagers as
select b.user_id,b.game,b.id,case when a.symbol='USDT' then div(b.stake*1e18::numeric,power(10::numeric,a.decimals))*1e-18::numeric
  else div(b.stake*1e18::numeric,coalesce(m.minor_per_usd,j.minor_per_usd,i.minor_per_usd,t.minor_per_usd,t.unit*600,
    case when i.game='cases' then (i.result->>'stake')::numeric/nullif((i.result->>'price')::numeric,0)*600 end,
    (select coalesce(q.minor_per_usd,q.unit*600) from game_quotes q where q.asset_id=b.asset_id and
     q.expires_at between b.created_at and b.created_at+interval '2 minutes' order by q.expires_at desc limit 1)))*1e-18::numeric end as usd
from player_bets b join assets a on a.id=b.asset_id
left join mines_rounds m on b.game='mines' and m.id::text=b.id and m.user_id=b.user_id
left join blackjack_rounds j on b.game='blackjack' and j.id::text=b.id and j.user_id=b.user_id
left join instant_rounds i on i.game=b.game and i.user_id=b.user_id and i.request::text=b.id
left join battles t on b.game='battles' and t.id::text=b.id
where b.stake>0 and b.status in ('lost','cashed','done','rolling');

create table notification_heads(user_id uuid primary key references users(id) on delete cascade, revision bigint not null default 0);
create table player_notifications(
 user_id uuid not null references users(id) on delete cascade,revision bigint not null,kind text not null,
 reference text not null,asset_id text references assets(id),amount numeric(78,0),chain_id text,txid text,
 confirmations int,required_conf int,created_at timestamptz not null default now(),read_at timestamptz,
 primary key(user_id,revision)
);
create index player_unread on player_notifications(user_id,revision) where read_at is null;
create function notify_player(uid uuid, event_kind text, ref text, asset text, units numeric, chain text default null,
 hash text default null, conf int default null, required int default null) returns void language plpgsql as $$
declare seq bigint;
begin
 insert into notification_heads values(uid,1) on conflict(user_id) do update set revision=notification_heads.revision+1 returning revision into seq;
 insert into player_notifications(user_id,revision,kind,reference,asset_id,amount,chain_id,txid,confirmations,required_conf)
 values(uid,seq,event_kind,ref,asset,units,chain,hash,conf,required);
 perform pg_notify('player_activity',uid::text);
end $$;

create function notify_deposit() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' and new.status=old.status then return new; end if;
 if new.status in ('pending','credited','orphaned') then
  perform notify_player(new.user_id,'deposit.'||new.status,new.id::text,new.asset_id,new.amount,new.chain_id,new.txid,new.confirmations,new.required_conf);
 end if;
 return new;
end $$;
create trigger deposit_notice after insert or update of status on deposits for each row execute function notify_deposit();

create function notify_withdrawal() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' and new.status=old.status then return new; end if;
 perform notify_player(new.user_id,'withdrawal.'||new.status,new.id::text,new.asset_id,new.amount,new.chain_id,new.txid);
 return new;
end $$;
create trigger withdrawal_notice after insert or update of status on withdrawals for each row execute function notify_withdrawal();
