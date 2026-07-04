-- Operator-confirmed exact mailing addresses for agreements, one per
-- property. Written automatically when send_agreement succeeds with a
-- property_id; resolve_property_address returns these verbatim so the
-- exact address only ever has to be confirmed once.
create table if not exists public.agreement_addresses (
  property_id uuid primary key references public.properties(id) on delete cascade,
  full_address text not null,
  confirmed_at timestamptz not null default now()
);

alter table public.agreement_addresses enable row level security;

create policy "authenticated read agreement addresses"
  on public.agreement_addresses for select to authenticated using (true);

create policy "authenticated write agreement addresses"
  on public.agreement_addresses for all to authenticated
  using (true) with check (true);
