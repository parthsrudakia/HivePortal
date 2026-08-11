-- Read-only SQL surface for the Telegram bot's query_database tool.
-- SELECT-only is enforced by Postgres itself — explicit per-table grants to a
-- low-privilege role plus a read-only transaction — never by inspecting the
-- SQL string.
--
-- Deliberately EXCLUDED from the whitelist (fail closed):
--   credentials, credential_access_log  — secrets and the secret access trail
--   audit_log                            — audit_credentials writes to_jsonb()
--                                          row images of credentials into it
--   telegram_chat_messages/updates/activity_log — the bot's own conversations
--   cleaner_schedule_change_queue        — carries a bearer token, low value
--   agreement_requests.token             — live 48h signing-link bearer token
--                                          (column-level grant below)
--
-- NOTE: new tables are INVISIBLE to the bot until granted here — when a
-- migration adds an operator-relevant table, add a grant + policy for it.

do $$ begin
  if not exists (select from pg_roles where rolname = 'bot_readonly') then
    create role bot_readonly nologin;
  end if;
end $$;

grant usage on schema public to bot_readonly;

do $$
declare t text;
begin
  foreach t in array array[
    'agreement_addresses','board_comments','board_prefs','board_tasks',
    'cleaners','cleaning_records','credit_allocations','email_log',
    'email_queue','ignored_payers','leaseholders','marketing_channels',
    'notification_recipients','payments','posting_log',
    'profitability_line_items','properties','property_cleaners',
    'reconciliation_deposits','reconciliation_reversals',
    'reconciliation_statements','rent_reminder_batches',
    'rent_reminder_emails','room_ads','room_change_events','rooms','sms_log',
    'tenancies','tenancy_charges','tenancy_rent_history',
    'tenant_payer_aliases','tenants','utility_bill_charges',
    'utility_bill_files','utility_bills','utility_overage_alerts',
    'utility_unit_hints'
  ]
  loop
    execute format('grant select on public.%I to bot_readonly', t);
    -- Existing RLS policies are scoped `to authenticated`; without an explicit
    -- policy this role would see zero rows on every table.
    execute format(
      'drop policy if exists bot_readonly_select on public.%I', t);
    execute format(
      'create policy bot_readonly_select on public.%I for select to bot_readonly using (true)',
      t);
  end loop;
end $$;

-- agreement_requests: everything except the signing-link bearer token.
-- Trade-off: future columns on this table need an explicit grant here too.
grant select (
  id, status, tenant_name, recipient_email, property_address, property_id,
  include_letterhead, channel, input, unsigned_pdf_path, signed_pdf_path,
  sent_at, expires_at, signed_at, tenant_signature_kind, sign_ip,
  dismissed_at, assigned_tenancy_id, assigned_at, created_at
) on public.agreement_requests to bot_readonly;
drop policy if exists bot_readonly_select on public.agreement_requests;
create policy bot_readonly_select on public.agreement_requests
  for select to bot_readonly using (true);

-- The query runner. SECURITY DEFINER and OWNED BY bot_readonly, so the
-- dynamic SQL executes with only that role's grants (SET ROLE is forbidden
-- inside security-definer functions, hence ownership). transaction_read_only
-- is the belt that blocks any write path the grants might miss (a body
-- statement — Postgres forbids it as a function SET clause). The subquery
-- wrapper makes a multi-statement payload a syntax error and caps rows
-- before aggregation. The in-function statement_timeout cannot re-arm the
-- already-running top-level statement — the effective time bound is the
-- caller's abort (PostgREST cancels the statement on client disconnect).
create or replace function public.bot_run_query(q text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '5s'
as $$
declare result jsonb;
begin
  set local transaction_read_only = on;
  execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from ('
       || 'select * from (' || rtrim(rtrim(q), ';') || ') bot_q limit 200'
       || ') t'
  into result;
  return result;
end $$;

-- Ownership dance: ALTER OWNER needs the migration role to be a member of
-- bot_readonly and the new owner to have CREATE on the schema (temporarily).
grant bot_readonly to postgres;
grant create on schema public to bot_readonly;
alter function public.bot_run_query(text) owner to bot_readonly;
revoke create on schema public from bot_readonly;

revoke all on function public.bot_run_query(text) from public;
revoke all on function public.bot_run_query(text) from anon;
revoke all on function public.bot_run_query(text) from authenticated;
grant execute on function public.bot_run_query(text) to service_role;
