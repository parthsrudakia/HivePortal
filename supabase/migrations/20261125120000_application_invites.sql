-- Application invites. A team member picks a room, sets the rent and deposit,
-- and emails the applicant a hiveny.com/apply-now?invite=TOKEN link. When the
-- paid application comes back from the website (keyed API), the portal sends
-- the agreement with the invite's terms; the applicant only supplies their
-- name, contact details and dates.

-- Sections are a deny-list (user_section_access.blocked_sections). Mirrors
-- getAccess()/requireSection in src/lib/section-access.ts: the master always
-- passes, everyone else passes unless the section is blocked for them. The
-- master email mirrors has_portal_permission(); update both together.
create or replace function public.has_portal_section(section text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'vdutta1485@gmail.com'
    or not exists (
      select 1 from public.user_section_access a
      where a.user_id = auth.uid() and section = any (a.blocked_sections)
    )
$$;

create table public.application_invites (
  id uuid primary key default gen_random_uuid(),
  -- Unguessable link token (32 random bytes, base64url).
  token text not null check (length(token) >= 32),
  property_id uuid not null references public.properties(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  applicant_email text not null,
  applicant_name text,
  -- Set by the team member only; the applicant can't change them.
  rent numeric(10, 2) not null check (rent > 0),
  security_deposit numeric(10, 2) not null check (security_deposit > 0),
  status text not null default 'sent'
    check (status in ('sent', 'used', 'expired', 'cancelled')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  email_sent_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  agreement_request_id uuid references public.agreement_requests(id) on delete set null,
  -- Filled in by the website's completion call. The agreement always goes to
  -- applicant_email (the person Hive invited); tenant_email is what they
  -- typed on the form, kept to flag a mismatch.
  website_application_id text,
  tenant_name text,
  tenant_email text,
  tenant_phone text,
  lease_start_date date,
  lease_end_date date,
  -- Short lock so two completion calls can't both send an agreement.
  claimed_at timestamptz,
  -- Stamped once the "send half the deposit by Zelle" email goes out after
  -- signing; the daily cron retries until it does.
  deposit_email_sent_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create unique index application_invites_token_idx on public.application_invites (token);
create index application_invites_status_idx on public.application_invites (status, created_at desc);
create unique index application_invites_agreement_request_idx
  on public.application_invites (agreement_request_id)
  where agreement_request_id is not null;

alter table public.application_invites enable row level security;

-- Same audience as the Agreements page. The keyed website API runs as the
-- service role and bypasses RLS.
create policy "agreements section all application_invites"
  on public.application_invites
  for all to authenticated
  using ((select public.has_portal_section('agreements')))
  with check ((select public.has_portal_section('agreements')));

create trigger audit_application_invites
  after insert or update or delete on public.application_invites
  for each row execute function public.audit_log_trigger();

-- Ops bot: everything except the link token.
grant select (
  id, property_id, room_id, applicant_email, applicant_name, rent,
  security_deposit, status, expires_at, email_sent_at, used_at, cancelled_at,
  agreement_request_id, website_application_id, tenant_name, tenant_email,
  tenant_phone, lease_start_date, lease_end_date, deposit_email_sent_at,
  created_by, created_at
) on public.application_invites to bot_readonly;
create policy bot_readonly_select on public.application_invites
  for select to bot_readonly using (true);
