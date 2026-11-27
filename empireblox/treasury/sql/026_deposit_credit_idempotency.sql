-- Keep the one-journal-per-deposit invariant in the database as a backstop to
-- creditConfirmedDeposit's row lock and same-transaction ledger update.
create unique index if not exists deposits_journal_uq
  on deposits(journal_id) where journal_id is not null;

create unique index if not exists direct_deposit_journal_ref_uq
  on journals(ref) where kind='deposit' and ref like 'deposit:%';
