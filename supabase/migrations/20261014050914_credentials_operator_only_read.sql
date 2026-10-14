-- Credentials are operator-only end to end: reads now match the existing
-- write policies (Vineet + Parth). Previously every authenticated portal user
-- could read service names, usernames, links and notes (passwords were
-- always encrypted and decryptable only by the operators). Mirrors
-- isOperator() in src/lib/access.ts — update both if the operator set changes.
drop policy "authenticated read credentials" on public.credentials;

create policy "owners read credentials" on public.credentials
  for select to authenticated
  using (
    lower(coalesce((select auth.jwt()) ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );
