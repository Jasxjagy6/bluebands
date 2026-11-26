-- Eighteen ledger decimals preserve every BEP-20 unit during consolidation.
-- Existing journals and on-chain observations retain their original asset.
insert into assets(id,chain_id,symbol,kind,decimals,enabled) values('USDT','ETH','USDT','ledger',18,true)
on conflict(id) do nothing;
lock table balances in share row exclusive mode;
do $$
declare r record; j bigint; converted numeric(78,0);
begin
 for r in select b.account,b.asset_id,b.amount,a.decimals from balances b join assets a on a.id=b.asset_id
   where b.account like 'u:%' and a.kind='token' and a.symbol='USDT' and b.amount>0 order by b.account,b.asset_id for update of b
 loop
   converted:=r.amount*power(10::numeric,18-r.decimals);
   insert into journals(kind,ref) values('currency_consolidation',r.account||'/'||r.asset_id) returning id into j;
   insert into ledger_entries(journal_id,account,asset_id,delta) values
     (j,r.account,r.asset_id,-r.amount),(j,'bridge:USDT',r.asset_id,r.amount),
     (j,'bridge:USDT','USDT',-converted),(j,r.account,'USDT',converted);
   update balances set amount=0 where account=r.account and asset_id=r.asset_id;
   insert into balances(account,asset_id,amount) values ('bridge:USDT',r.asset_id,r.amount),
     ('bridge:USDT','USDT',-converted),(r.account,'USDT',converted)
     on conflict(account,asset_id) do update set amount=balances.amount+excluded.amount;
 end loop;
 update users set display_ccy='USDT' where display_ccy in(select id from assets where symbol='USDT');
end $$;
-- Reconcile late legacy deposits and payouts from a replica finishing an old
-- hand during a rolling deploy. Each conversion balances both denominations.
create or replace function consolidate_usdt_credit() returns trigger language plpgsql as $$
declare places int; j bigint; converted numeric(78,0); legacy_units numeric(78,0);
begin
 if new.account not like 'u:%' or new.asset_id='USDT' or new.amount<=0 then return new; end if;
 select decimals into places from assets where id=new.asset_id and kind='token' and symbol='USDT';
 if not found then return new; end if;
 legacy_units:=new.amount;converted:=legacy_units*power(10::numeric,18-places);
 insert into journals(kind,ref) values('currency_consolidation',new.asset_id) returning id into j;
 insert into ledger_entries(journal_id,account,asset_id,delta) values
   (j,new.account,new.asset_id,-legacy_units),(j,'bridge:USDT',new.asset_id,legacy_units),
   (j,'bridge:USDT','USDT',-converted),(j,new.account,'USDT',converted);
 update balances set amount=0 where account=new.account and asset_id=new.asset_id;
 insert into balances(account,asset_id,amount) values('bridge:USDT',new.asset_id,legacy_units),
   ('bridge:USDT','USDT',-converted),(new.account,'USDT',converted)
   on conflict(account,asset_id) do update set amount=balances.amount+excluded.amount;
 return new;
end $$;
create or replace trigger consolidate_usdt_after_credit after insert or update of amount on balances
 for each row when(new.account like 'u:%' and new.asset_id<>'USDT' and new.amount>0) execute function consolidate_usdt_credit();

create table if not exists withdrawals(
 id uuid primary key,user_id uuid not null references users(id),request uuid not null,
 asset_id text not null references assets(id), route_asset text not null references assets(id),chain_id text not null,
 destination text not null,amount numeric(78,0) not null check(amount>0),status text not null default 'requested'
 check(status in('requested','cancelled','reviewing','sent')),created_at timestamptz not null default now(),unique(user_id,request)
);
alter table withdrawals add column if not exists txid text;
alter table withdrawals add column if not exists reviewer_id int references admin_users(id);
create index if not exists withdrawals_player_history on withdrawals(user_id,created_at desc);
create index if not exists withdrawals_queue on withdrawals(created_at) where status in ('requested','reviewing');
create unique index if not exists withdrawal_chain_tx on withdrawals(chain_id,txid) where txid is not null;
create or replace view player_bets as
select m.user_id,'mines'::text as game,m.id::text as id,m.asset_id,m.bet as stake,m.payout,
 m.status,m.created_at,jsonb_build_object('Board size',m.size,'Mines',m.mines,'Tiles revealed',cardinality(m.revealed),
 'Revealed tiles',(select jsonb_agg(i+1) from unnest(m.revealed) i),'Mine positions',case when m.status<>'active' then (select jsonb_agg(i+1) from unnest(m.mine_positions) i) end) as detail
from mines_rounds m
union all select b.user_id,'blackjack',b.id::text,b.asset_id,
 (select sum((h->>'bet')::numeric) from jsonb_array_elements(b.state->'hands') h)+coalesce((b.state->>'insurance')::numeric,0),
 (b.state->>'payout')::numeric,b.status,b.created_at,jsonb_build_object('Dealer cards',case when b.status='done' then b.state->'dealer' else jsonb_build_array(b.state->'dealer'->0) end,'Hands',b.state->'hands','Insurance',b.state->>'insurance') from blackjack_rounds b
union all select i.user_id,i.game,i.request::text,i.asset_id,(i.result->>'stake')::numeric,(i.result->>'payout')::numeric,'done',i.created_at,
 jsonb_strip_nulls(jsonb_build_object('Case',i.result->>'case','Item',i.result->>'name','Roll',i.result->>'roll','Chance (%)',i.result->>'chance','Roll over',i.result->'over','Reward level',i.result->>'level')) from instant_rounds i
union all select u.id,'battles',b.id::text,b.asset_id,ceil(b.cost*(100-b.borrow[s.i])/100.0)*b.unit,
 case when b.status='cancelled' then ceil(b.cost*(100-b.borrow[s.i])/100.0)*b.unit else coalesce((b.payouts->>(s.i-1))::numeric,0)*b.unit end,b.status,b.created_at,
 jsonb_build_object('Mode',b.mode,'Seat',s.i,'Cases',b.case_ids,'Borrow (%)',b.borrow[s.i],'Crazy',b.crazy,'Jackpot',b.jackpot,
 'Pulls',(select jsonb_agg(item.name order by pick.ord) from jsonb_array_elements_text(b.results->(s.i-1)) with ordinality pick(idx,ord)
 join case_items item on item.case_id=b.case_ids[pick.ord] and item.idx=pick.idx::int))
 from battles b cross join lateral generate_subscripts(b.seats,1) s(i) join users u on u.id::text=b.seats[s.i];
