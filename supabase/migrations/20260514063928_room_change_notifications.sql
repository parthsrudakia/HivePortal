-- Global recipient list for room-change notifications (no auth required,
-- recipients are just email addresses VIN-VINNY maintains in the portal).
create table notification_recipients (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  label       text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create index notification_recipients_enabled_idx
  on notification_recipients (enabled);

alter table notification_recipients enable row level security;
create policy "authenticated read notification_recipients"
  on notification_recipients for select to authenticated using (true);
create policy "authenticated write notification_recipients"
  on notification_recipients for all to authenticated using (true) with check (true);


-- Log of every status / listing_action change. Drives both the immediate
-- email (sent inline by the app on change) and the 24h follow-up
-- (sent by a daily cron that looks for events where followup_sent_at is null
-- and changed_at is older than 24h).
create table room_change_events (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references rooms(id) on delete cascade,
  field              text not null check (field in ('status', 'listing_action')),
  from_value         text,
  to_value           text,
  changed_at         timestamptz not null default now(),
  immediate_sent_at  timestamptz,
  immediate_error    text,
  followup_sent_at   timestamptz,
  followup_error     text
);

create index room_change_events_changed_at_idx
  on room_change_events (changed_at);
create index room_change_events_pending_followup_idx
  on room_change_events (changed_at)
  where followup_sent_at is null;

alter table room_change_events enable row level security;
create policy "authenticated read room_change_events"
  on room_change_events for select to authenticated using (true);
create policy "authenticated write room_change_events"
  on room_change_events for all to authenticated using (true) with check (true);
