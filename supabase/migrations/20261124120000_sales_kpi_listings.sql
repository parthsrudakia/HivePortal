-- Sales KPIs: demand per unit and time on market.
--
-- Each agent may now send the ads its account runs (`listings`): when each
-- unit was last listed, when it was deactivated, and every price change with
-- its date. Like the open-thread lists, it is "right now" state kept on the
-- stream row and replaced whenever the agent sends it again.
--
-- Per-unit lead counts need no schema change: each `leads_by_address` entry
-- (jsonb) may now also carry `unit`, `unit_style` and `handoffs`.

-- [{ address, unit?, unit_style?, listed_on, deactivated_on?, price?,
--    price_changes?: [{ date, from?, to, note? }] }]
alter table public.sales_kpi_streams
  add column if not exists listings jsonb not null default '[]'::jsonb,
  add column if not exists listings_as_of timestamptz;
