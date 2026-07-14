-- Manual line items on the Profitability summary: extra revenue or expense
-- rows (e.g. admin costs, one-off income) added on top of the unit-derived
-- figures, per calendar year.
create table if not exists public.profitability_line_items (
  id uuid primary key default gen_random_uuid(),
  year integer not null,
  side text not null check (side in ('revenue', 'expense')),
  label text not null,
  amount numeric not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.profitability_line_items enable row level security;
create policy "authenticated read profitability_line_items"
  on public.profitability_line_items for select to authenticated using (true);
create policy "authenticated write profitability_line_items"
  on public.profitability_line_items for all to authenticated
  using (true) with check (true);

create index if not exists profitability_line_items_year_idx
  on public.profitability_line_items (year, side);
