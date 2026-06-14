-- =====================================================================
-- Rent ledger: carry-forward balances + non-rent buckets
-- =====================================================================
-- Moves rent from a per-month snapshot to a running, carry-forward ledger
-- and adds three more buckets the operator tracks alongside rent:
--   * security deposit  -> stays on tenancies.security_deposit (owed)
--   * broker fee        -> ad-hoc charge (tenancy_charges)
--   * late fee (~$50)   -> ad-hoc charge (tenancy_charges)
--
-- An overpayment of rent can be *directed* to one of these buckets via a
-- credit_allocations row, which moves the excess out of rent without
-- mutating the immutable payments rows (so reconciliation's external_ref /
-- unpost logic is untouched).
-- =====================================================================

-- 1) New payment type for direct broker-fee cash payments. (Postgres forbids
--    USING a newly added enum value in the same transaction, so we only add
--    it here — no statement below references 'broker_fee'.)
alter type payment_type add value if not exists 'broker_fee';

-- 2) Ad-hoc owed amounts that aren't rent or the security deposit.
create table tenancy_charges (
  id          uuid primary key default gen_random_uuid(),
  tenancy_id  uuid not null references tenancies(id) on delete cascade,
  kind        text not null check (kind in ('broker_fee', 'late_fee', 'other')),
  amount      numeric(10,2) not null check (amount > 0),
  charged_on  date not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);
create index tenancy_charges_tenancy_idx on tenancy_charges (tenancy_id);

-- 3) Directs part of a rent overpayment into another bucket. Tenancy-scoped:
--    the allocation moves `amount` out of the tenancy's rent credit and into
--    `kind`. Reversible by deleting the row.
create table credit_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenancy_id  uuid not null references tenancies(id) on delete cascade,
  kind        text not null check (kind in ('security_deposit', 'broker_fee', 'late_fee', 'other')),
  amount      numeric(10,2) not null check (amount > 0),
  note        text,
  created_at  timestamptz not null default now()
);
create index credit_allocations_tenancy_idx on credit_allocations (tenancy_id);

-- 4) RLS — same "any authenticated user" policy as every other table.
alter table tenancy_charges    enable row level security;
alter table credit_allocations enable row level security;

create policy "authenticated read charges" on tenancy_charges
  for select to authenticated using (true);
create policy "authenticated write charges" on tenancy_charges
  for all to authenticated using (true) with check (true);

create policy "authenticated read allocations" on credit_allocations
  for select to authenticated using (true);
create policy "authenticated write allocations" on credit_allocations
  for all to authenticated using (true) with check (true);
