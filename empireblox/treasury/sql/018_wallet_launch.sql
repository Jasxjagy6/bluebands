-- Switching intake does not cancel previously issued hosted invoices.
update settings set value='"direct"'::jsonb,updated_at=now() where key='deposit_provider';
create or replace view playing_assets as select a.* from assets a where a.enabled and a.kind in ('native','ledger');

create table custody_admin_challenges (
  admin_id integer primary key references admin_users(id),
  last_step bigint not null
);
