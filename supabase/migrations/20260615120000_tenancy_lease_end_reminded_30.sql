-- Second lease-ending reminder milestone. The original reminder fires ~45 days
-- before lease_end_date (tracked by lease_end_reminded_at). This adds a closer
-- ~30-day reminder, tracked independently so each milestone fires exactly once.
-- Like lease_end_reminded_at it is reset to null whenever lease_end_date changes
-- (see setTenancyLeaseEndDate), re-arming both reminders.
alter table tenancies
  add column lease_end_reminded_30_at timestamptz;
