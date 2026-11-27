-- Retire checkout without deleting settled ledger entries or audit evidence.
delete from settings where key='deposit_provider';
delete from secrets where name='oxapay:merchant';
update oxapay_invoices set next_check_at=null where next_check_at is not null;

-- Deposit readiness never hides an existing playing balance. Match the launch
-- policy in 018 without retaining 015's dependency on the removed setting.
create or replace view playing_assets as
select a.* from assets a where a.enabled and a.kind in ('native','ledger');

create function reject_retired_checkout_write() returns trigger language plpgsql as $$
begin
  raise exception 'Hosted checkout is retired; historical payment evidence is read-only';
end $$;
create trigger retired_checkout_invoices before insert or update or delete on oxapay_invoices
  for each row execute function reject_retired_checkout_write();
-- BEFORE triggers run alphabetically: custody_skip_internal_invoice must run
-- first and keep suppressing internal-transfer inserts without claiming them.
create trigger retired_checkout_transfers before insert or update or delete on oxapay_transfers
  for each row execute function reject_retired_checkout_write();

-- Preserve prior payments as archived history, with no executable checkout flow.
create or replace view deposit_records as
select d.id::text,'direct'::text as provider,d.user_id,d.asset_id,d.amount,d.status,d.first_seen_at,d.credited_at,
  d.chain_id,d.txid,d.address,d.confirmations,d.required_conf,d.review_hold,d.journal_id,null::text as track_id
from deposits d
union all
select i.id::text,'archived',i.user_id,i.asset_id,i.amount,i.status,i.created_at,i.credited_at,
  null,null,null,null,null,null,i.journal_id,i.track_id
from oxapay_invoices i;
