-- Sales KPIs reported by the lead-handling agents (Grok and others).
--
-- Each agent POSTs a snapshot to /api/sales-kpis for the listing account it
-- works ("Name on account", e.g. Vineet's or Parth's SpareRoom). Rows are
-- append-only history; the Inventory page shows the latest row per
-- (account_name, platform, agent). Every metric is optional so an agent can
-- send only what it measures.
create table if not exists public.sales_kpi_reports (
  id uuid primary key default gen_random_uuid(),
  account_name text not null check (length(trim(account_name)) between 1 and 100),
  agent text not null check (length(trim(agent)) between 1 and 60),
  platform text check (platform is null or length(platform) <= 60),
  period_start date,
  period_end date,
  total_leads integer check (total_leads is null or total_leads >= 0),
  first_reply_hours numeric(10, 2) check (first_reply_hours is null or first_reply_hours >= 0),
  replies_per_day numeric(10, 2) check (replies_per_day is null or replies_per_day >= 0),
  -- Percentages, 0–100.
  handoff_rate numeric(5, 2) check (handoff_rate is null or handoff_rate between 0 and 100),
  handoffs integer check (handoffs is null or handoffs >= 0),
  follow_up_rate numeric(5, 2) check (follow_up_rate is null or follow_up_rate between 0 and 100),
  -- [{ lead, days_waiting, address?, last_message_at? }]
  waiting_on_us jsonb not null default '[]'::jsonb,
  never_answered integer check (never_answered is null or never_answered >= 0),
  -- [{ lead, address?, received_at? }]
  never_answered_leads jsonb not null default '[]'::jsonb,
  -- [{ address, leads }]
  leads_by_address jsonb not null default '[]'::jsonb,
  notes text check (notes is null or length(notes) <= 2000),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sales_kpi_reports_period check (
    period_start is null or period_end is null or period_start <= period_end
  )
);

create index if not exists sales_kpi_reports_latest_idx
  on public.sales_kpi_reports (account_name, platform, agent, reported_at desc);

-- Read-only in the portal, behind the 'sales_kpis' permission (Vineet always;
-- grant others at Settings → Access control). Writes come only from the API
-- via the service role.
alter table public.sales_kpi_reports enable row level security;
drop policy if exists "sales_kpis read sales_kpi_reports" on public.sales_kpi_reports;
create policy "sales_kpis read sales_kpi_reports" on public.sales_kpi_reports
  for select to authenticated
  using ((select public.has_portal_permission('sales_kpis')));
