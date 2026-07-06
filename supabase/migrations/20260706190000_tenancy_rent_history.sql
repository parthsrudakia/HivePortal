-- Per-month rent rates, so a rent change applies to FUTURE months only.
--
-- The ledger previously derived every month's auto rent charge from the
-- tenancy's current monthly_rent — a renewal increase silently repriced all
-- settled past months. Each row here says "from this month onward the rate
-- is X"; the ledger picks the latest row at or before each billed month.
-- On a tenancy's first rate change the original rate is backfilled as a
-- baseline row effective from the start month.
create table tenancy_rent_history (
  id              uuid primary key default gen_random_uuid(),
  tenancy_id      uuid not null references tenancies(id) on delete cascade,
  effective_month date not null,
  monthly_rent    numeric(10,2) not null check (monthly_rent > 0),
  created_at      timestamptz not null default now(),
  unique (tenancy_id, effective_month)
);
create index tenancy_rent_history_tenancy_idx
  on tenancy_rent_history (tenancy_id);

alter table tenancy_rent_history enable row level security;
create policy "authenticated read rent history" on tenancy_rent_history
  for select to authenticated using (true);
-- Writes follow the ledger rule: operators only.
create policy "ledger admins write rent history" on tenancy_rent_history
  for all to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      in ('vdutta1485@gmail.com', 'parthrudakia@gmail.com')
  )
  with check (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      in ('vdutta1485@gmail.com', 'parthrudakia@gmail.com')
  );

create trigger audit_tenancy_rent_history
  after insert or update or delete on tenancy_rent_history
  for each row execute function public.audit_log_trigger();
