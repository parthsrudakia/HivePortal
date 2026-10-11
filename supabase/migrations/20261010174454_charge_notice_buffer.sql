-- 5-minute correction buffer on the "Other" charge email. Adding a manual
-- charge no longer emails the tenant straight away: it parks a row here with
-- send_after = now() + 5 min. Deleting the charge cascades the row away, so a
-- charge deleted inside the window never emails (a correction is delete +
-- re-add, which starts its own 5 minutes). The email is built from the charge
-- row at send time.
--
-- Vercel Hobby crons are daily-only, so pg_cron checks every minute and, only
-- when something is due, pings /api/cron/charge-notices via pg_net. The URL
-- and CRON_SECRET live in Vault (set once by hand, not in this file):
--   select vault.create_secret('https://<portal host>', 'portal_url');
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
-- The daily follow-up cron also flushes due rows as a safety net.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.charge_notices (
  charge_id uuid primary key references public.tenancy_charges (id) on delete cascade,
  send_after timestamptz not null,
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index charge_notices_due_idx on public.charge_notices (send_after) where sent_at is null;

-- Service role only (the add-charge action and the cron both use it).
alter table public.charge_notices enable row level security;

-- Atomically claims due, unsent notices so overlapping runs never double-send.
-- A claim older than 10 minutes is treated as a crashed run and retried; a
-- notice gives up after 5 attempts (last_error says why).
create or replace function public.claim_due_charge_notices()
returns setof public.charge_notices
language sql
security definer
set search_path = public
as $$
  update public.charge_notices n
     set claimed_at = now(),
         attempts = n.attempts + 1
   where n.charge_id in (
     select charge_id
       from public.charge_notices
      where sent_at is null
        and send_after <= now()
        and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      for update skip locked
   )
  returning n.*;
$$;

revoke all on function public.claim_due_charge_notices() from public, anon, authenticated;
grant execute on function public.claim_due_charge_notices() to service_role;

select cron.schedule(
  'charge-notices',
  '* * * * *',
  $cron$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'portal_url')
           || '/api/cron/charge-notices',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  )
  where exists (
    select 1 from public.charge_notices
     where sent_at is null
       and send_after <= now()
       and attempts < 5
       and (claimed_at is null or claimed_at < now() - interval '10 minutes')
  );
  $cron$
);
