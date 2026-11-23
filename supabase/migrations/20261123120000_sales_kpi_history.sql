-- Sales KPIs become daily history so the Inventory page can filter by date.
--
-- The agents (Grok and others) send one account per call, named by
-- `account_name`. The first call dumps every past day they have; later calls
-- send only new (or corrected) days. A day is keyed by
-- (account_key, platform, agent, day), so re-sending a day replaces it.
--
-- Replaces the snapshot table from 20261122120000, which never held data.
drop table if exists public.sales_kpi_reports;

-- One row per account + platform + agent + day. Counts are summed over a
-- date range; rates are derived (handoffs / leads, followed_up / leads), and
-- first_reply_hours is averaged weighted by leads.
create table if not exists public.sales_kpi_days (
  id uuid primary key default gen_random_uuid(),
  -- lower-cased, whitespace-collapsed account_name: the account's identity.
  account_key text not null check (length(account_key) between 1 and 100),
  account_name text not null check (length(trim(account_name)) between 1 and 100),
  platform text not null default '' check (length(platform) <= 60),
  agent text not null check (length(agent) between 1 and 60),
  day date not null,
  leads integer not null default 0 check (leads >= 0),
  first_reply_hours numeric(10, 2) check (first_reply_hours is null or first_reply_hours >= 0),
  replies_sent integer check (replies_sent is null or replies_sent >= 0),
  handoffs integer check (handoffs is null or handoffs >= 0),
  followed_up integer check (followed_up is null or followed_up >= 0),
  never_answered integer check (never_answered is null or never_answered >= 0),
  -- [{ address, leads }]
  leads_by_address jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint sales_kpi_days_stream_day_key unique (account_key, platform, agent, day)
);
create index if not exists sales_kpi_days_day_idx on public.sales_kpi_days (day);

-- One row per account + platform + agent: the registry of accounts the
-- filters list, plus the "right now" state each call may send (threads
-- waiting on us, leads never answered).
create table if not exists public.sales_kpi_streams (
  id uuid primary key default gen_random_uuid(),
  account_key text not null check (length(account_key) between 1 and 100),
  account_name text not null,
  platform text not null default '',
  agent text not null,
  -- [{ lead, days_waiting, address?, last_message_at? }]
  waiting_on_us jsonb not null default '[]'::jsonb,
  -- [{ lead, address?, received_at? }]
  never_answered_leads jsonb not null default '[]'::jsonb,
  open_as_of timestamptz,
  last_received_at timestamptz not null default now(),
  constraint sales_kpi_streams_key unique (account_key, platform, agent)
);

-- Each user's saved default filters for the KPI panel.
create table if not exists public.sales_kpi_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  filters jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.sales_kpi_days enable row level security;
alter table public.sales_kpi_streams enable row level security;
alter table public.sales_kpi_prefs enable row level security;

-- KPI data: read-only in the portal behind 'sales_kpis'; written only by the
-- API through the service role.
drop policy if exists "sales_kpis read sales_kpi_days" on public.sales_kpi_days;
create policy "sales_kpis read sales_kpi_days" on public.sales_kpi_days
  for select to authenticated
  using ((select public.has_portal_permission('sales_kpis')));
drop policy if exists "sales_kpis read sales_kpi_streams" on public.sales_kpi_streams;
create policy "sales_kpis read sales_kpi_streams" on public.sales_kpi_streams
  for select to authenticated
  using ((select public.has_portal_permission('sales_kpis')));

-- Prefs: each user reads and writes only their own row.
drop policy if exists "own sales_kpi_prefs (select)" on public.sales_kpi_prefs;
create policy "own sales_kpi_prefs (select)" on public.sales_kpi_prefs
  for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "own sales_kpi_prefs (insert)" on public.sales_kpi_prefs;
create policy "own sales_kpi_prefs (insert)" on public.sales_kpi_prefs
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.has_portal_permission('sales_kpis')));
drop policy if exists "own sales_kpi_prefs (update)" on public.sales_kpi_prefs;
create policy "own sales_kpi_prefs (update)" on public.sales_kpi_prefs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select public.has_portal_permission('sales_kpis')));
