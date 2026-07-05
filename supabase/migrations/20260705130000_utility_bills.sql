-- Utilities expense log: one row per uploaded statement, with its charges
-- broken out (current usage vs late fees vs other) in a side table.
-- Previous-balance / amount-carried-forward lines are never stored.
create table if not exists public.utility_bills (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references public.properties(id) on delete set null,
  provider text,
  utility_type text not null default 'other'
    check (utility_type in ('electric', 'gas', 'water', 'internet', 'trash', 'other')),
  account_number text,
  service_address text,
  statement_date date,
  period_start date,
  period_end date,
  due_date date,
  total_amount numeric not null default 0,
  statement_path text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.utility_bill_charges (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.utility_bills(id) on delete cascade,
  kind text not null default 'current'
    check (kind in ('current', 'late_fee', 'other')),
  description text,
  amount numeric not null
);

create index if not exists utility_bills_property_idx on public.utility_bills (property_id);
create index if not exists utility_bill_charges_bill_idx on public.utility_bill_charges (bill_id);

alter table public.utility_bills enable row level security;
alter table public.utility_bill_charges enable row level security;

create policy "authenticated read utility bills"
  on public.utility_bills for select to authenticated using (true);
create policy "authenticated write utility bills"
  on public.utility_bills for all to authenticated using (true) with check (true);

create policy "authenticated read utility charges"
  on public.utility_bill_charges for select to authenticated using (true);
create policy "authenticated write utility charges"
  on public.utility_bill_charges for all to authenticated using (true) with check (true);

-- Private bucket for the uploaded statements (PDF or photo).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'utilities',
  'utilities',
  false,
  20971520, -- 20 MB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "authenticated read utilities" on storage.objects;
create policy "authenticated read utilities"
  on storage.objects for select to authenticated
  using (bucket_id = 'utilities');

drop policy if exists "authenticated write utilities" on storage.objects;
create policy "authenticated write utilities"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'utilities');

drop policy if exists "authenticated delete utilities" on storage.objects;
create policy "authenticated delete utilities"
  on storage.objects for delete to authenticated
  using (bucket_id = 'utilities');
