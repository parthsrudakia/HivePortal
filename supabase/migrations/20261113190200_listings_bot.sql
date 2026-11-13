-- Listings bot: a second Telegram bot (its own token, separate from the ops
-- bot) that sits in the team's group chat. It posts every inventory change so
-- the team can update the listing ads, and posts reminders the admin sets up
-- by DMing the bot. See src/lib/listings-bot/.
--
-- Change detection is a snapshot diff, not per-mutation hooks: the bot keeps
-- the last inventory-API payload it announced per room and compares it with
-- the live one, so a change is caught whichever code path made it. A trigger
-- only stamps "something touched rooms/properties"; pg_cron then pings the
-- portal once edits have been quiet for 2 minutes (so a burst of edits, or an
-- edit and its correction, becomes one message).

create table public.listing_bot_state (
  id boolean primary key default true check (id),
  -- The team group the bot posts to (set with /setgroup in that group).
  group_chat_id bigint,
  group_title text,
  -- Stamped by the triggers below; cleared once the diff has been posted.
  dirty_at timestamptz,
  -- Run lock so overlapping pings never post the same diff twice.
  processing_at timestamptz,
  -- Null until the first run stores a baseline (which posts nothing).
  seeded_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.listing_bot_state default values;

-- Last announced inventory-API payload per in-inventory room.
create table public.listing_bot_snapshots (
  room_id uuid primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.listing_bot_reminders (
  id bigserial primary key,
  message text not null,
  -- { kind: once|daily|weekly|monthly|interval, time: "HH:MM" (Eastern), ... }
  schedule jsonb not null,
  -- Live data appended when it fires: none | open_actions | inventory.
  include text not null default 'none'
    check (include in ('none', 'open_actions', 'inventory')),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  fail_count integer not null default 0,
  created_by bigint,
  created_at timestamptz not null default now()
);

create index listing_bot_reminders_due_idx
  on public.listing_bot_reminders (next_run_at) where enabled;

-- The admin's DM conversation with the bot (plain text turns).
create table public.listing_bot_messages (
  id bigserial primary key,
  chat_id bigint not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index listing_bot_messages_chat_idx
  on public.listing_bot_messages (chat_id, created_at);

-- Webhook dedup (Telegram re-delivers an update until it gets a 200). Its own
-- table: update ids are per bot, so they can collide with the ops bot's.
create table public.listing_bot_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

-- Service role only (webhook + cron); no policies.
alter table public.listing_bot_state enable row level security;
alter table public.listing_bot_snapshots enable row level security;
alter table public.listing_bot_reminders enable row level security;
alter table public.listing_bot_messages enable row level security;
alter table public.listing_bot_updates enable row level security;

-- Stamps the dirty flag. Must never block a room/property edit, so any
-- failure here is swallowed (the daily cron diffs regardless).
create or replace function public.mark_listing_inventory_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    update public.listing_bot_state set dirty_at = now() where id;
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.mark_listing_inventory_dirty() from public, anon, authenticated;

create trigger rooms_listing_bot_dirty
  after insert or update or delete on public.rooms
  for each statement execute function public.mark_listing_inventory_dirty();

create trigger properties_listing_bot_dirty
  after update on public.properties
  for each statement execute function public.mark_listing_inventory_dirty();

-- Same Vault secrets as the charge-notices job (portal_url, cron_secret).
-- Pings only when a diff is due (2 quiet minutes) or a reminder is due.
select cron.schedule(
  'listings-bot',
  '* * * * *',
  $cron$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'portal_url')
           || '/api/cron/listings-bot',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  )
  where exists (
    select 1 from public.listing_bot_state
     where dirty_at is not null
       and dirty_at <= now() - interval '2 minutes'
  )
  or exists (
    select 1 from public.listing_bot_reminders
     where enabled
       and next_run_at <= now()
  );
  $cron$
);
