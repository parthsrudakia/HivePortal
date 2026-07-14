-- H3: credential passwords were stored plaintext (`credentials.password`,
-- "TODO Phase 5.5: encrypt"). Encrypt at rest with pgcrypto, keyed by a secret
-- held in Supabase Vault (never in the table or in code). Plaintext is moved
-- into `password_cipher` and the `password` column is emptied.
--
-- Access paths (see 20260716095000 for the write RLS + plaintext block):
--   * public.credential_password(uuid)          — authenticated masters only
--     (web "Reveal"); enforces the operator allowlist via auth.jwt().
--   * public.credential_password_internal(uuid)  — service role only (the
--     Telegram bot / server), no email check.
--   * public.set_credential_password(uuid,text)  — masters/service role; the
--     only supported way to write a password (encrypts, clears plaintext).

create extension if not exists pgcrypto with schema extensions;

-- One-time 256-bit symmetric key in Vault.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'credentials_enc_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'credentials_enc_key',
      'Symmetric key for credentials.password_cipher (pgp_sym)'
    );
  end if;
end $$;

alter table public.credentials add column if not exists password_cipher bytea;

-- Internal decrypt (no auth gate) — service role / server only.
create or replace function public.credential_password_internal(cred_id uuid)
returns text
language plpgsql
security definer
set search_path = 'public', 'vault', 'extensions'
as $$
declare v_cipher bytea; v_key text;
begin
  select password_cipher into v_cipher from public.credentials where id = cred_id;
  if v_cipher is null then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'credentials_enc_key';
  return extensions.pgp_sym_decrypt(v_cipher, v_key);
end $$;
revoke all on function public.credential_password_internal(uuid) from public, anon, authenticated;
grant execute on function public.credential_password_internal(uuid) to service_role;

-- Master-gated decrypt for the web "Reveal" (session JWT carries the email).
create or replace function public.credential_password(cred_id uuid)
returns text
language plpgsql
security definer
set search_path = 'public', 'vault', 'extensions'
as $$
begin
  if lower(coalesce(auth.jwt() ->> 'email', ''))
       <> all (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com']) then
    raise exception 'forbidden';
  end if;
  return public.credential_password_internal(cred_id);
end $$;
revoke all on function public.credential_password(uuid) from public, anon;
grant execute on function public.credential_password(uuid) to authenticated, service_role;

-- The only supported password writer: encrypts and clears any plaintext.
create or replace function public.set_credential_password(cred_id uuid, plaintext text)
returns void
language plpgsql
security definer
set search_path = 'public', 'vault', 'extensions'
as $$
declare v_key text;
begin
  if lower(coalesce(auth.jwt() ->> 'email', ''))
       <> all (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
     and auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if plaintext is null or plaintext = '' then
    update public.credentials set password_cipher = null, password = null where id = cred_id;
    return;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'credentials_enc_key';
  update public.credentials
     set password_cipher = extensions.pgp_sym_encrypt(plaintext, v_key),
         password = null
   where id = cred_id;
end $$;
revoke all on function public.set_credential_password(uuid, text) from public, anon;
grant execute on function public.set_credential_password(uuid, text) to authenticated, service_role;

-- Backfill existing plaintext into ciphertext, then wipe the plaintext column.
-- (No-op on a fresh database.)
do $$
declare v_key text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'credentials_enc_key';
  update public.credentials
     set password_cipher = extensions.pgp_sym_encrypt(password, v_key)
   where password is not null and password <> '' and password_cipher is null;
  update public.credentials set password = null where password is not null;
end $$;
