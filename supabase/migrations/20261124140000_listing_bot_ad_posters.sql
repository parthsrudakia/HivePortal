-- Listings bot: only rooms with an ad up are announced, and only the people
-- who posted those ads are asked to confirm.
--
-- room_ads.posted_by holds the poster's PORTAL name (display name, else
-- email), which is not their Telegram name, so each roster row carries the
-- portal names its ads are saved under. The admin sets them in a private chat
-- with /link @username Portal Name. See src/lib/listings-bot/acks.ts.
alter table public.listing_bot_members
  add column if not exists poster_names text[] not null default '{}';

-- Who a change post is waiting on (listing_bot_members.id). Null = the whole
-- reminder list: scheduled reminders, and tasks from before this change.
alter table public.listing_bot_tasks
  add column if not exists assignee_ids bigint[];

-- The two people on the reminder list, under the names their ads carry.
update public.listing_bot_members
   set poster_names = '{"Gian V"}'
 where lower(username) = 'gvillarino' and poster_names = '{}';
update public.listing_bot_members
   set poster_names = '{"Mary Grace Consuelo"}'
 where lower(username) = 'graceconsuelo' and poster_names = '{}';
