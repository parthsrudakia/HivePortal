-- Many-to-many cleaners ↔ properties.
-- Replaces the single properties.cleaner_id FK: one property can now be
-- assigned to multiple cleaners, and a cleaner can cover many units. Every
-- assigned cleaner is emailed when the unit's cleaning schedule changes.

create table property_cleaners (
  property_id uuid not null references properties(id) on delete cascade,
  cleaner_id  uuid not null references cleaners(id)   on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (property_id, cleaner_id)
);

alter table property_cleaners enable row level security;
create policy "authenticated read property_cleaners"
  on property_cleaners for select to authenticated using (true);
create policy "authenticated write property_cleaners"
  on property_cleaners for all to authenticated using (true) with check (true);

create index property_cleaners_cleaner_id_idx on property_cleaners (cleaner_id);

-- Carry existing single-cleaner assignments into the join table.
insert into property_cleaners (property_id, cleaner_id)
  select id, cleaner_id from properties
  where cleaner_id is not null
  on conflict do nothing;

-- Audit assignment changes like the rest of the operational tables.
create trigger audit_property_cleaners
  after insert or update or delete on property_cleaners
  for each row execute function public.audit_log_trigger();

-- Retire the single-cleaner column now that the join table is the source of truth.
drop index if exists properties_cleaner_id_idx;
alter table properties drop column cleaner_id;
