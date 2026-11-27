-- Operator policy: five confirmations for every monitored network/asset.
-- The scanner still verifies canonical history; Solana still requires finalized evidence.
update chains set required_conf=5;
update deposits set required_conf=5
where journal_id is null and credited_at is null and status in ('pending','confirmed');
insert into audit_log(actor,action,detail)
values('system','deposits.confirmation_policy','{"required_confirmations":5,"pending_deposits_updated":true}');
