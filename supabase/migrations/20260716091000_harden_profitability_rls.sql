-- M1: profitability_line_items had `using(true) with check(true)` for every
-- authenticated user, so a non-owner could read/write per-unit P&L via the raw
-- PostgREST API, bypassing the app-layer canViewProfitability() gate. Harden it
-- to the two-operator allowlist at the DB level, matching the ledger tables.

drop policy if exists "authenticated read profitability_line_items"  on public.profitability_line_items;
drop policy if exists "authenticated write profitability_line_items" on public.profitability_line_items;

create policy "owners read profitability_line_items"
  on public.profitability_line_items
  for select to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );

create policy "owners write profitability_line_items"
  on public.profitability_line_items
  for all to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  )
  with check (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );
