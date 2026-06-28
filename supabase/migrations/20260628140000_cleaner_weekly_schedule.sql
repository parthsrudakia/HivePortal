-- Weekly cleaner schedule digests + debounced change notices.
--
-- 1) Each cleaner gets a stable, unguessable token used as their public
--    schedule-page link (https://.../s/<token>). The same link is sent in the
--    Sunday digest and in every "schedule updated" notice; it always renders
--    the current week, live.
alter table cleaners
  add column if not exists schedule_token uuid not null default gen_random_uuid();
create unique index if not exists cleaners_schedule_token_idx
  on cleaners (schedule_token);

-- 2) Debounce buffer. A schedule change (move-out or manual edit) that affects
--    the current week enqueues one row per affected cleaner. The evening cron
--    drains pending rows (sent_at is null), sends a single "updated" notice per
--    cleaner+week, and stamps sent_at so a day's changes go out together.
create table if not exists cleaner_schedule_change_queue (
  id          uuid primary key default gen_random_uuid(),
  cleaner_id  uuid not null references cleaners(id) on delete cascade,
  week_start  date not null,
  reason      text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

alter table cleaner_schedule_change_queue enable row level security;
create policy "authenticated read cleaner_schedule_change_queue"
  on cleaner_schedule_change_queue for select to authenticated using (true);
create policy "authenticated insert cleaner_schedule_change_queue"
  on cleaner_schedule_change_queue for insert to authenticated with check (true);

create index cleaner_change_pending_idx
  on cleaner_schedule_change_queue (cleaner_id, week_start)
  where sent_at is null;
