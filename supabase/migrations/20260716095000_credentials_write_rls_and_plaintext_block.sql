-- H4 (DB side) + H3 hardening for the credentials vault:
--   * Restrict INSERT/UPDATE/DELETE to the two operators at the RLS layer
--     (previously any authenticated user could create/delete/rewrite rows).
--     SELECT stays open to authenticated — non-secret fields only; the
--     password lives encrypted in password_cipher and is useless without the
--     Vault key, and the plaintext column is force-nulled below.
--   * A BEFORE trigger guarantees the plaintext `password` column can never be
--     repopulated, regardless of client — the encrypted setter is the only
--     supported write path.

drop policy if exists "authenticated write credentials" on public.credentials;

create policy "owners write credentials"
  on public.credentials
  for all to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  )
  with check (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );

create or replace function public.credentials_block_plaintext()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Never persist a plaintext password; use set_credential_password() instead.
  new.password := null;
  return new;
end $$;

drop trigger if exists credentials_block_plaintext on public.credentials;
create trigger credentials_block_plaintext
  before insert or update on public.credentials
  for each row execute function public.credentials_block_plaintext();
