-- Sales KPIs: rejected leads.
--
-- The team now labels each unqualified lead "Rejected" on the listing site.
-- `rejected` = of that day's leads, how many carry that label. Per-address
-- rejected counts ride in the leads_by_address jsonb ({ ..., rejected }).
alter table public.sales_kpi_days
  add column if not exists rejected integer check (rejected is null or rejected >= 0);
