-- Listings bot: a pause switch.
--
-- While paused_at is set, the background pass (runListingsBot) posts nothing
-- to the team group: no "inventory updated" notices, no scheduled reminders,
-- no 2-hourly ad follow-ups. The webhook still records reactions and
-- "done" replies. Set it back to null to resume; the pass then catches up
-- (one change notice for whatever moved, and each overdue reminder once).
alter table public.listing_bot_state
  add column if not exists paused_at timestamptz;
