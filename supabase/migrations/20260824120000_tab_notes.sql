-- Shared per-tab notepads: one free-text note per portal tab (Rent
-- Tracker, Utilities, Inventory), readable and editable by every portal
-- user — the same note for everyone, last write wins.
create table public.tab_notes (
  tab text primary key
    check (tab in ('tenants', 'utilities', 'inventory')),
  content text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.tab_notes enable row level security;

create policy "authenticated all tab_notes" on public.tab_notes
  for all to authenticated using (true) with check (true);

create trigger audit_tab_notes
  after insert or update or delete on public.tab_notes
  for each row execute function public.audit_log_trigger();
