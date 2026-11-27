create table user_authenticators (
  user_id uuid primary key references users(id) on delete cascade,
  enc_dek bytea not null,iv bytea not null,tag bytea not null,ciphertext bytea not null,
  enabled_at timestamptz,setup_expires_at timestamptz,last_step bigint not null default -1,
  recovery_hashes bytea[] not null default '{}',
  check((enabled_at is null)=(setup_expires_at is not null))
);
-- Enable enrollment only after every serving API replica supports player MFA.
insert into settings(key,value) values('player_2fa_available','false') on conflict do nothing;
