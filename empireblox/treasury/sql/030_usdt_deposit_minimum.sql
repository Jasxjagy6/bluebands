-- Accept 0.1 USDT per transfer, expressed in each network's integer units.
-- Historical credits, cursors, assignments and native-coin minimums are retained.
update assets set min_deposit=power(10::numeric,decimals-1)
where symbol='USDT' and kind='token';

-- Keep managed collection eligibility consistent with the accepted minimum.
create or replace view custody_sweep_credits as
select d.id as deposit_id,d.journal_id,da.id as address_id,d.chain_id,d.asset_id,d.address as source,
       da.custody_key_id as key_id,da.deriv_index,d.amount,d.txid as deposit_txid,d.log_index as deposit_index,
       d.block_number as deposit_block,d.block_hash as deposit_block_hash,d.required_conf,
       case when d.chain_id<>'SOL' then k.fee_address end as sponsor,
       k.ready as key_ready,(n.enabled and a.enabled) as route_enabled,n.required_conf as network_conf,
       greatest(a.min_deposit,case d.asset_id when 'USDT.BEP20' then 100000000000000000::numeric
         when 'USDT.ERC20' then 100000 when 'USDT.POL' then 100000 when 'SOL' then 1000000
         when 'ETH' then 2000000000000000 when 'BNB' then 10000000000000000 when 'POL' then 1000000000000000000 end) as minimum
from deposits d join deposit_addresses da on (da.chain_id,da.address,da.user_id)=(d.chain_id,d.address,d.user_id)
join custody_public_key k on k.key_id=da.custody_key_id and k.configured
join custody_launch_assets a on (a.chain_id,a.id)=(d.chain_id,d.asset_id) join chains n on n.id=d.chain_id
join journals j on j.id=d.journal_id and j.kind='deposit' and j.ref='deposit:'||d.id
where da.custody_kind='managed' and da.created_at<=d.first_seen_at and d.status='credited' and not d.review_hold
  and d.credited_at is not null and d.confirmed_at is not null and d.confirmations>=d.required_conf and d.required_conf>0
  and d.amount>0 and d.block_number>0 and da.deriv_index between 0 and 2147483647 and n.required_conf>0
  and case when d.chain_id='SOL' then d.txid ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' and d.block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' and d.log_index>=0
    else d.txid ~ '^0x[0-9a-f]{64}$' and d.block_hash ~ '^0x[0-9a-f]{64}$' and
      (case when a.kind='native' then d.log_index=-1 else d.log_index>=0 end) end
  and ((d.chain_id='SOL' and exists(select 1 from custody_sol_pool p where (p.key_id,p.deriv_index,p.address,p.user_id)=(da.custody_key_id,da.deriv_index,da.address,da.user_id)))
    or (d.chain_id in ('ETH','BSC','POL') and k.fee_address is not null and exists(select 1 from custody_evm_users p
      where (p.key_id,p.deriv_index,p.address,p.user_id)=(da.custody_key_id,da.deriv_index,da.address,da.user_id))))
  and exists(select 1 from ledger_entries e where e.journal_id=j.id and e.account='ext:'||d.chain_id and e.asset_id=d.asset_id and e.delta=-d.amount)
  and exists(select 1 from ledger_entries e where e.journal_id=j.id and e.account='u:'||d.user_id
    and e.asset_id=case when a.kind='token' then 'USDT' else d.asset_id end
    and e.delta=case when a.kind='token' then d.amount*power(10::numeric,18-a.decimals) else d.amount end)
  and not exists(select 1 from custody_sweep_steps s where s.chain_id=d.chain_id and s.txid=case when d.chain_id='SOL' then d.txid else lower(d.txid) end);
