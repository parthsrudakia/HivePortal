-- One-off login reminders: a popup shown to a specific portal user the
-- next time they load the app after the reminder becomes due. Due-ness is
-- either tied to a tenancy's move-out (visible once move_out_date is set
-- and has passed) or to a fixed show_after date.
create table public.login_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  message text not null,
  -- When set, visible once this tenancy's move_out_date is on/before today.
  tenancy_id uuid references public.tenancies (id) on delete cascade,
  -- Fallback trigger when no tenancy is linked: visible on/after this date.
  show_after date,
  dismissed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  constraint login_reminders_has_trigger
    check (tenancy_id is not null or show_after is not null)
);

alter table public.login_reminders enable row level security;

-- Users see and dismiss only their own reminders; rows are created by
-- operators via privileged paths (service role), so no insert policy.
create policy "login_reminders_select_own" on public.login_reminders
  for select using (user_id = (select auth.uid()));

create policy "login_reminders_update_own" on public.login_reminders
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create index login_reminders_user_pending_idx
  on public.login_reminders (user_id)
  where dismissed_at is null;
