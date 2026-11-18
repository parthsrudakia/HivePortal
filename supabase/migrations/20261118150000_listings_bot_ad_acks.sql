-- Listings bot: ad-update acknowledgements. Every inventory-change post in
-- the team group becomes a task; each tracked team member acknowledges it by
-- reacting (any emoji) to the change post or to a reminder that covers it.
-- Until everyone has, the bot posts one combined reminder every 2 hours
-- between 8 AM and 6 PM Eastern, tagging only the people still missing.
-- See src/lib/listings-bot/acks.ts.

-- When the next combined reminder is due (null = nothing open).
alter table public.listing_bot_state add column nag_next_at timestamptz;

-- The team roster. Only rows with remind = true are tagged and must react;
-- the admin adds them by @username. Telegram gives bots no way to resolve a
-- username to a user id, so a row may start with user_id null; it is filled
-- in the first time that person posts or reacts in the group. Everyone else
-- the bot sees there is recorded with remind = false.
create table public.listing_bot_members (
  id bigserial primary key,
  user_id bigint unique,
  first_name text,
  last_name text,
  -- Stored without the leading "@".
  username text,
  remind boolean not null default false,
  -- False once they leave the group.
  active boolean not null default true,
  -- Set when the bot saw them join; they are not asked about older changes.
  -- Null = already in the group when the bot started tracking.
  joined_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or username is not null)
);

create unique index listing_bot_members_username_idx
  on public.listing_bot_members (lower(username));

-- The team members asked to update their ads (per the admin).
insert into public.listing_bot_members (username, remind) values
  ('graceconsuelo', true),
  ('gvillarino', true);

-- One per inventory-change post.
create table public.listing_bot_tasks (
  id bigserial primary key,
  chat_id bigint not null,
  -- Short code-built summary lines (Telegram HTML), one per room changed.
  lines text[] not null,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  last_reminded_at timestamptz
);

create index listing_bot_tasks_open_idx
  on public.listing_bot_tasks (created_at) where done_at is null;

-- Every group message a reaction can acknowledge, and the tasks it covers.
create table public.listing_bot_posts (
  chat_id bigint not null,
  message_id bigint not null,
  kind text not null check (kind in ('change', 'reminder')),
  task_ids bigint[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

create table public.listing_bot_acks (
  task_id bigint not null references public.listing_bot_tasks (id) on delete cascade,
  user_id bigint not null,
  -- The message they reacted to.
  message_id bigint,
  acked_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

-- Service role only (webhook + cron); no policies.
alter table public.listing_bot_members enable row level security;
alter table public.listing_bot_tasks enable row level security;
alter table public.listing_bot_posts enable row level security;
alter table public.listing_bot_acks enable row level security;

-- Same job as before, now also pinged when a combined reminder is due.
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
     where (dirty_at is not null and dirty_at <= now() - interval '2 minutes')
        or nag_next_at <= now()
  )
  or exists (
    select 1 from public.listing_bot_reminders
     where enabled
       and next_run_at <= now()
  );
  $cron$
);
