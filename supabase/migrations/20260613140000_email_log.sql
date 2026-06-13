-- Unified log of every outbound email the portal sends, so Admin Settings can
-- show a filterable history of what went out, to whom, and whether it landed.
--   type      — what the email was for (rent_reminder, rent_balance,
--               room_change, cleaning_moveout, …).
--   context   — free-form tag (the unit/room, the rent period, etc.).
-- Rows are written by the logEmail() helper using the service role, so no
-- write policy is needed; authenticated users may read.
create table email_log (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  recipient   text not null,
  subject     text,
  status      text not null check (status in ('sent', 'failed')),
  error       text,
  context     text,
  resend_id   text,
  created_at  timestamptz not null default now()
);

alter table email_log enable row level security;
create policy "authenticated read email_log"
  on email_log for select to authenticated using (true);

create index email_log_created_at_idx on email_log (created_at desc);
create index email_log_type_idx on email_log (type, created_at desc);
