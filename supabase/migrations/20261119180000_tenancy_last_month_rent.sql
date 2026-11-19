-- Optional override for the rent billed in a tenancy's move-out month, the
-- mirror of first_month_rent. Set by room transfers: the old room bills only
-- the days the tenant actually stayed that month,
--   monthly_rent / days in month * days stayed,
-- instead of a full month on top of the new room's prorated first month.
-- Null = the move-out month bills the normal monthly rate.
alter table tenancies
  add column last_month_rent numeric(10, 2);

alter table tenancies
  add constraint tenancies_last_month_rent_nonnegative
    check (last_month_rent is null or last_month_rent >= 0);
