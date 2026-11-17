-- Actual monthly costs for the Profitability tab.
--
-- One row per cost line: a unit's rent paid, internet, cleaning, insurance,
-- amenity or misc charge for a month, or a company-wide cost (Upwork, admin)
-- with no unit. Rows come from the costs agent via POST
-- /api/profitability/costs (source 'agent'), the monthly company cost form on
-- /profitability (source 'manual') or a file upload (source 'upload').
--
-- When a unit has an actual row for a month, the tab uses it instead of the
-- unit's flat monthly figure on the properties table. `ref` is the sender's
-- stable id for the line, so re-sending the same line replaces it instead of
-- adding a duplicate.
create table if not exists public.profit_costs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references public.properties(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  cost_type text not null check (
    cost_type in ('rent_paid', 'internet', 'cleaning', 'insurance', 'amenity', 'misc', 'company')
  ),
  amount numeric(12, 2) not null,
  label text,
  source text not null default 'manual' check (source in ('agent', 'manual', 'upload')),
  ref text not null,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Company costs have no unit; every other cost belongs to one.
  constraint profit_costs_unit_scope check ((cost_type = 'company') = (property_id is null)),
  constraint profit_costs_source_ref_key unique (source, ref)
);

create index if not exists profit_costs_month_idx on public.profit_costs (month);
create index if not exists profit_costs_property_id_idx on public.profit_costs (property_id);

alter table public.profit_costs enable row level security;
create policy "profitability read profit_costs" on public.profit_costs
  for select to authenticated
  using ((select public.has_portal_permission('profitability')));
create policy "profitability write profit_costs (insert)" on public.profit_costs
  for insert to authenticated
  with check ((select public.has_portal_permission('profitability')));
create policy "profitability write profit_costs (update)" on public.profit_costs
  for update to authenticated
  using ((select public.has_portal_permission('profitability')))
  with check ((select public.has_portal_permission('profitability')));
create policy "profitability write profit_costs (delete)" on public.profit_costs
  for delete to authenticated
  using ((select public.has_portal_permission('profitability')));

drop trigger if exists audit_profit_costs on public.profit_costs;
create trigger audit_profit_costs
  after insert or update or delete on public.profit_costs
  for each row execute function public.audit_log_trigger();

-- The Telegram bot's read-only query tool can sum these like the other
-- profitability inputs.
grant select on public.profit_costs to bot_readonly;
drop policy if exists bot_readonly_select on public.profit_costs;
create policy bot_readonly_select on public.profit_costs
  for select to bot_readonly using (true);
