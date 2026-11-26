-- Direct network switches control receiving/withdrawal routes, not hosted coin balances.
create view playing_assets as
select a.* from assets a join chains c on c.id=a.chain_id
where a.enabled and (a.kind='ledger' or (a.kind='native' and
  (c.enabled or (select value from settings where key='deposit_provider')='"oxapay"'::jsonb)));

-- Hosted references are not chain transaction hashes. Keep both sources read-only here;
-- their independent settlement paths retain their own idempotency and review rules.
create view deposit_records as
select d.id::text, 'direct'::text as provider, d.user_id, d.asset_id, d.amount,
       d.status, d.first_seen_at, d.credited_at, d.chain_id, d.txid, d.address,
       d.confirmations, d.required_conf, d.review_hold, d.journal_id, null::text as track_id
from deposits d
union all
select i.id::text, 'oxapay', i.user_id, i.asset_id, i.amount, i.status,
       i.created_at, i.credited_at, null, null, null, null, null, null, i.journal_id, i.track_id
from oxapay_invoices i;
