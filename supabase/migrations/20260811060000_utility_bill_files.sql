-- Extra attachments for a utility bill beyond its primary statement
-- (statement_path). Manual entry can attach several screenshots; the first
-- stays on utility_bills.statement_path, the rest live here.
create table if not exists public.utility_bill_files (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.utility_bills(id) on delete cascade,
  file_path text not null,
  file_name text,
  file_sha256 text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists utility_bill_files_bill_idx on public.utility_bill_files (bill_id);
create index if not exists utility_bill_files_sha_idx on public.utility_bill_files (file_sha256);

alter table public.utility_bill_files enable row level security;

create policy "authenticated read utility bill files"
  on public.utility_bill_files for select to authenticated using (true);
create policy "authenticated write utility bill files"
  on public.utility_bill_files for all to authenticated using (true) with check (true);
