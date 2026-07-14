-- The monthly automatic late-fee pass records a batch row per month (its
-- run-once marker), reusing rent_reminder_batches with a new kind.
alter table public.rent_reminder_batches
  drop constraint if exists rent_reminder_batches_kind_check;
alter table public.rent_reminder_batches
  add constraint rent_reminder_batches_kind_check
  check (kind in ('general', 'balance', 'late_fee'));
