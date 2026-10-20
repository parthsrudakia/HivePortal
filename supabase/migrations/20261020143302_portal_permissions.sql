-- Access control v2: only Vineet (the master) has full access. Everything
-- the old two-person "operator" list gave Parth is now a grantable
-- permission that Vineet toggles per user at Settings → Access control.
-- Keys mirror PORTAL_PERMISSIONS in src/lib/section-access.ts; the master
-- email mirrors isMaster() in src/lib/access.ts — update both together.

alter table public.user_section_access
  add column granted_permissions text[] not null default '{}';

-- True for the master, or when the signed-in user has been granted `perm`.
-- SECURITY INVOKER: callers can only see their own access row (RLS), which
-- is all this needs. Definer functions that call it (via
-- is_financial_operator) still filter on auth.uid().
create or replace function public.has_portal_permission(perm text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'vdutta1485@gmail.com'
    or exists (
      select 1 from public.user_section_access a
      where a.user_id = auth.uid() and perm = any (a.granted_permissions)
    )
$$;

-- Financial writes (tenants, tenancies, properties, payments, recon,
-- utilities, their storage buckets and the recon/rent RPCs) follow the
-- 'ledger' permission. Logs and notification settings get their own
-- permissions below instead of riding on this.
create or replace function public.is_financial_operator()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.role() = 'service_role'
    or public.has_portal_permission('ledger')
$$;

create or replace function public.credential_password(cred_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault', 'extensions'
as $function$
begin
  if not public.has_portal_permission('credentials') then
    raise exception 'forbidden';
  end if;
  return public.credential_password_internal(cred_id);
end $function$;

create or replace function public.set_credential_password(cred_id uuid, plaintext text)
returns void
language plpgsql
security definer
set search_path to 'public', 'vault', 'extensions'
as $function$
declare v_key text;
begin
  if not public.has_portal_permission('credentials')
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
end $function$;

-- credentials → 'credentials'
alter policy "owners read credentials" on public.credentials
  using ((select public.has_portal_permission('credentials')));
alter policy "owners write credentials (insert)" on public.credentials
  with check ((select public.has_portal_permission('credentials')));
alter policy "owners write credentials (update)" on public.credentials
  using ((select public.has_portal_permission('credentials'))) with check ((select public.has_portal_permission('credentials')));
alter policy "owners write credentials (delete)" on public.credentials
  using ((select public.has_portal_permission('credentials')));

-- credential_access_log → 'credentials'
alter policy "owners read access log" on public.credential_access_log
  using ((select public.has_portal_permission('credentials')));

-- profitability_line_items → 'profitability'
alter policy "owners read profitability_line_items" on public.profitability_line_items
  using ((select public.has_portal_permission('profitability')));
alter policy "owners write profitability_line_items (insert)" on public.profitability_line_items
  with check ((select public.has_portal_permission('profitability')));
alter policy "owners write profitability_line_items (update)" on public.profitability_line_items
  using ((select public.has_portal_permission('profitability'))) with check ((select public.has_portal_permission('profitability')));
alter policy "owners write profitability_line_items (delete)" on public.profitability_line_items
  using ((select public.has_portal_permission('profitability')));

-- credit_allocations → 'ledger'
alter policy "ledger admins write allocations (insert)" on public.credit_allocations
  with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write allocations (update)" on public.credit_allocations
  using ((select public.has_portal_permission('ledger'))) with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write allocations (delete)" on public.credit_allocations
  using ((select public.has_portal_permission('ledger')));

-- tenancy_charges → 'ledger'
alter policy "ledger admins write charges (insert)" on public.tenancy_charges
  with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write charges (update)" on public.tenancy_charges
  using ((select public.has_portal_permission('ledger'))) with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write charges (delete)" on public.tenancy_charges
  using ((select public.has_portal_permission('ledger')));

-- tenancy_rent_history → 'ledger'
alter policy "ledger admins write rent history (insert)" on public.tenancy_rent_history
  with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write rent history (update)" on public.tenancy_rent_history
  using ((select public.has_portal_permission('ledger'))) with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write rent history (delete)" on public.tenancy_rent_history
  using ((select public.has_portal_permission('ledger')));

-- tenant_payer_aliases → 'ledger'
alter policy "ledger admins write payer aliases (insert)" on public.tenant_payer_aliases
  with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write payer aliases (update)" on public.tenant_payer_aliases
  using ((select public.has_portal_permission('ledger'))) with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write payer aliases (delete)" on public.tenant_payer_aliases
  using ((select public.has_portal_permission('ledger')));

-- utility_overage_alerts → 'ledger'
alter policy "ledger admins write overage alerts (insert)" on public.utility_overage_alerts
  with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write overage alerts (update)" on public.utility_overage_alerts
  using ((select public.has_portal_permission('ledger'))) with check ((select public.has_portal_permission('ledger')));
alter policy "ledger admins write overage alerts (delete)" on public.utility_overage_alerts
  using ((select public.has_portal_permission('ledger')));

-- telegram_chat_messages → 'logs'
alter policy "owners read telegram chat" on public.telegram_chat_messages
  using ((select public.has_portal_permission('logs')));

-- audit_log → 'logs'
alter policy "financial operators read audit log" on public.audit_log
  using ((select public.has_portal_permission('logs')));

-- email_log → 'logs'
alter policy "operators read email_log" on public.email_log
  using ((select public.has_portal_permission('logs')));

-- email_queue → 'logs'
alter policy "operators read email_queue" on public.email_queue
  using ((select public.has_portal_permission('logs')));

-- sms_log → 'logs'
alter policy "operators read sms_log" on public.sms_log
  using ((select public.has_portal_permission('logs')));

-- telegram_activity_log → 'logs'
alter policy "financial operators read telegram activity log" on public.telegram_activity_log
  using ((select public.has_portal_permission('logs')));

-- notification_recipients → 'notifications'
alter policy "operators write notification_recipients (insert)" on public.notification_recipients
  with check ((select public.has_portal_permission('notifications')));
alter policy "operators write notification_recipients (update)" on public.notification_recipients
  using ((select public.has_portal_permission('notifications'))) with check ((select public.has_portal_permission('notifications')));
alter policy "operators write notification_recipients (delete)" on public.notification_recipients
  using ((select public.has_portal_permission('notifications')));

-- Parth keeps everything he had as an operator until Vineet changes it.
insert into public.user_section_access (user_id, granted_permissions)
select id, array['credentials', 'profitability', 'ledger', 'logs',
                 'notifications', 'developers', 'assistant']
from auth.users where lower(email) = 'parthrudakia@gmail.com'
on conflict (user_id) do update
  set granted_permissions = excluded.granted_permissions;
