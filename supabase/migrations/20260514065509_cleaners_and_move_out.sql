-- Cleaners: one cleaner per property (FK on properties). Cleaner gets
-- emailed whenever the unit's cleaning schedule changes.
create table cleaners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  phone       text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table cleaners enable row level security;
create policy "authenticated read cleaners"
  on cleaners for select to authenticated using (true);
create policy "authenticated write cleaners"
  on cleaners for all to authenticated using (true) with check (true);

alter table properties
  add column cleaner_id uuid references cleaners(id) on delete set null;
create index properties_cleaner_id_idx on properties (cleaner_id);


-- Extend cleaning_records:
--   kind        = 'regular' (manually logged) or 'move_out' (auto-scheduled
--                  one day before a room's available_from).
--   room_id     = which specific room is being vacated (for move_out kind);
--                  null for regular full-unit cleanings.
-- Future-dated move_out rows are filtered out of the "last cleaned" /
-- next-due computation so the regular 35-day cadence stays accurate.
alter table cleaning_records
  add column kind text not null default 'regular'
    check (kind in ('regular', 'move_out')),
  add column room_id uuid references rooms(id) on delete set null;

create index cleaning_records_kind_idx on cleaning_records (kind);
create index cleaning_records_room_id_idx on cleaning_records (room_id);
