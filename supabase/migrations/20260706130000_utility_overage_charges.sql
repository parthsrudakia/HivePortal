-- Utility overage → tenant ledger charges.
--
-- When a unit's electric/gas usage exceeds the $200 lease threshold, the
-- excess is split per-day among the tenants living in that unit's AC rooms
-- during the billing period and posted to their rent ledgers.

-- 1) New ledger charge kind for the split.
alter table tenancy_charges drop constraint tenancy_charges_kind_check;
alter table tenancy_charges add constraint tenancy_charges_kind_check
  check (kind in ('security_deposit', 'late_fee', 'utility_overage', 'other'));

-- 2) Guard so the same bill can't be charged to tenants twice.
alter table utility_bills add column overage_charged_at timestamptz;

-- 3) Shares that belong to tenants who had already moved out when the charge
--    was calculated are NOT posted; they surface as a popup on the Rent
--    Tracker until the admin acknowledges them. Names/labels are cached so
--    the alert still reads well if the bill or tenancy is later deleted.
create table utility_overage_alerts (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid references utility_bills(id) on delete set null,
  tenancy_id      uuid references tenancies(id) on delete set null,
  tenant_name     text not null,
  unit_label      text not null,
  amount          numeric(10,2) not null,
  period_label    text not null,
  created_at      timestamptz not null default now(),
  acknowledged_at timestamptz
);

alter table utility_overage_alerts enable row level security;
create policy "authenticated read overage alerts" on utility_overage_alerts
  for select to authenticated using (true);
create policy "authenticated write overage alerts" on utility_overage_alerts
  for all to authenticated using (true) with check (true);
