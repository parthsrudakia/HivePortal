-- Emergency contact per tenant, collected through a public token form
-- (/emergency-contact/<token>, no login — the token in the URL is the only
-- credential). One row per tenant: created when the request email goes out
-- (contact fields still null), filled in when the tenant submits. The tenant
-- can reopen the same link to update it; the token never rotates on its own.
create table emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  contact_name text,
  relationship text,
  contact_email text,
  contact_phone text,
  requested_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Submitted means every field is present: the form makes all four mandatory.
  constraint emergency_contacts_complete_when_submitted check (
    submitted_at is null or (
      contact_name is not null and relationship is not null
      and contact_email is not null and contact_phone is not null
    )
  )
);

create unique index emergency_contacts_token_idx on emergency_contacts (token);

alter table emergency_contacts enable row level security;

-- Single-operator model, same as the rest of the schema. No anon policies:
-- the public form goes through the service role only.
create policy "authenticated all emergency_contacts"
  on emergency_contacts
  for all
  to authenticated
  using (true)
  with check (true);

-- Telegram bot read access: everything except the form-link bearer token.
grant select (
  id, tenant_id, contact_name, relationship, contact_email, contact_phone,
  requested_at, submitted_at, created_at, updated_at
) on public.emergency_contacts to bot_readonly;
create policy bot_readonly_select on public.emergency_contacts
  for select to bot_readonly using (true);
