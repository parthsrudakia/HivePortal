-- Link utility-overage ledger charges back to the bill that produced them,
-- so an overage charge run can be unposted (charges deleted, alerts cleared,
-- bill reopened) as one unit.
alter table tenancy_charges
  add column bill_id uuid references utility_bills(id) on delete set null;
create index tenancy_charges_bill_idx on tenancy_charges (bill_id);
