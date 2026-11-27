-- Public scan progress only. Existing ownership, funds and signed history are untouched.
create table sol_address_scans (
  query_address text primary key,
  address_id bigint not null references deposit_addresses(id),
  last_scanned bigint not null check(last_scanned>=0),
  target_slot bigint check(target_slot>last_scanned),
  before_signature text,
  before_slot bigint,
  overlap_signature text,
  overlap_slot bigint,
  anchor_signature text,
  anchor_slot bigint,
  newest_signature text,
  newest_slot bigint,
  updated_at timestamptz not null default now(),
  check((before_signature is null)=(before_slot is null)),
  check((overlap_signature is null)=(overlap_slot is null)),
  check((before_signature is null)=(overlap_signature is null)),
  check((anchor_signature is null)=(anchor_slot is null)),
  check((newest_signature is null)=(newest_slot is null)),
  check(before_signature is null or target_slot is not null)
);
create index sol_address_scans_pending on sol_address_scans(last_scanned,updated_at);
