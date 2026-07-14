-- Negative Zelle rows (chargebacks / returned transfers) found in uploaded
-- bank statements. Previously these were dropped at parse time with only a
-- note; now each is stored, matched to the posted payment it likely
-- reverses, and surfaced on the run page until an operator records the
-- refund or dismisses it.
create table if not exists public.reconciliation_reversals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_runs(id) on delete cascade,
  -- Fingerprint of the reversal row itself ("zellerev:<conf>" or a hash) —
  -- unique so re-uploading an overlapping statement can't duplicate alerts.
  external_ref text not null unique,
  payer_key text not null,
  raw_description text not null,
  amount numeric not null,             -- positive magnitude of the reversal
  deposit_date date,
  -- Best guess at the posted payment being reversed (same payer + amount).
  suspect_payment_id uuid references public.payments(id) on delete set null,
  resolved_at timestamptz,
  resolved_by text,
  resolution text check (resolution in ('refunded', 'dismissed')),
  refund_payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.reconciliation_reversals enable row level security;
create policy "authenticated read reconciliation_reversals"
  on public.reconciliation_reversals for select to authenticated using (true);
create policy "authenticated write reconciliation_reversals"
  on public.reconciliation_reversals for all to authenticated
  using (true) with check (true);

create index if not exists reconciliation_reversals_run_idx
  on public.reconciliation_reversals (run_id, resolved_at);
