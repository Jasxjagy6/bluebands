-- Replicas share one polling schedule per chain. A second healthy replica
-- remains available for failover without doubling normal provider usage.
alter table chains add column if not exists next_scan_at timestamptz;
