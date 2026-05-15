-- Per-Zelle-transaction dedupe.
--
-- payments.external_ref is the unique fingerprint of a bank deposit
-- (Zelle Conf# in practice). When reconciliation Post writes a payments
-- row for a deposit, it sets external_ref = "zelle:<confnum>". The
-- partial unique index makes the second attempt to insert the same
-- transaction a no-op (ON CONFLICT DO NOTHING), so re-uploading
-- overlapping bank statements never produces duplicate payments.

alter table payments
  add column external_ref text;

create unique index payments_external_ref_unique
  on payments (external_ref)
  where external_ref is not null;


-- Per-deposit reconciliation log. One row per Zelle transaction the
-- parser found, regardless of whether it matched a tenant. The run
-- detail page sums these for display; Post payments iterates these
-- to write payment rows.
create table reconciliation_deposits (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references reconciliation_runs(id) on delete cascade,
  tenancy_id        uuid references tenancies(id) on delete set null,
  external_ref      text not null,
  payer_key         text not null,    -- the lowercased "after-from" name
  raw_description   text not null,
  amount            numeric(12,2) not null,
  deposit_date      date,
  payment_id        uuid references payments(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index reconciliation_deposits_run_idx
  on reconciliation_deposits (run_id);
create index reconciliation_deposits_external_ref_idx
  on reconciliation_deposits (external_ref);
create index reconciliation_deposits_tenancy_idx
  on reconciliation_deposits (tenancy_id);

alter table reconciliation_deposits enable row level security;
create policy "authenticated read recon deposits"
  on reconciliation_deposits for select to authenticated using (true);
create policy "authenticated write recon deposits"
  on reconciliation_deposits for all to authenticated using (true) with check (true);
