-- Listings bot: scheduled reminders can require confirmation. When
-- needs_confirmation is on, each firing tags the reminder list and becomes a
-- task like an inventory change: the team reacts or replies "done", and
-- whoever hasn't is re-tagged every 2 hours (8 AM - 6 PM ET). Off = a plain
-- post, as before. See src/lib/listings-bot/acks.ts.

alter table public.listing_bot_reminders
  add column needs_confirmation boolean not null default false;

alter table public.listing_bot_tasks
  add column kind text not null default 'inventory'
    check (kind in ('inventory', 'reminder')),
  -- The reminder whose firing created it (kind = 'reminder').
  add column reminder_id bigint
    references public.listing_bot_reminders (id) on delete set null;

create index listing_bot_tasks_reminder_idx
  on public.listing_bot_tasks (reminder_id) where done_at is null;
