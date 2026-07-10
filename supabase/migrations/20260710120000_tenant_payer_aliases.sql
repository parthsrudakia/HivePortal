-- Remembered payer → tenant matches for reconciliation.
--
-- Assigning an unmatched deposit used to overwrite the tenant's single
-- pays_as alias: the previous alias was lost, and a tenant with an alias no
-- longer matched deposits under their own name. Each row here permanently
-- maps one normalized bank payer key to a tenant; reconciliation matches a
-- tenancy's deposits by its pays_as/full-name key PLUS every alias of its
-- tenant, so once a payer is assigned it matches automatically in every
-- future run.
create table tenant_payer_aliases (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  payer_key    text not null unique,
  -- The bank's printed payer name (original case), for display.
  display_name text,
  created_at   timestamptz not null default now()
);
create index tenant_payer_aliases_tenant_idx
  on tenant_payer_aliases (tenant_id);

alter table tenant_payer_aliases enable row level security;
create policy "authenticated read payer aliases" on tenant_payer_aliases
  for select to authenticated using (true);
-- Writes follow the ledger rule: operators only.
create policy "ledger admins write payer aliases" on tenant_payer_aliases
  for all to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      in ('vdutta1485@gmail.com', 'parthrudakia@gmail.com')
  )
  with check (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      in ('vdutta1485@gmail.com', 'parthrudakia@gmail.com')
  );

create trigger audit_tenant_payer_aliases
  after insert or update or delete on tenant_payer_aliases
  for each row execute function public.audit_log_trigger();
