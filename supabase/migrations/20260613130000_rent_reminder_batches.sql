-- Records each batch of rent reminders so the UI can show when reminders last
-- went out, separately for:
--   'general' — the monthly cron reminder sent to every active tenant.
--   'balance' — the manual reminder sent only to tenants who still owe rent
--               for the current month (typically run after reconciliation).
create table rent_reminder_batches (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('general', 'balance')),
  period_month    text not null,            -- 'YYYY-MM'
  recipient_count integer not null default 0,
  triggered_by    text,                     -- user email, or 'cron'
  created_at      timestamptz not null default now()
);

alter table rent_reminder_batches enable row level security;
create policy "authenticated read rent_reminder_batches"
  on rent_reminder_batches for select to authenticated using (true);
create policy "authenticated write rent_reminder_batches"
  on rent_reminder_batches for all to authenticated using (true) with check (true);

create index rent_reminder_batches_kind_idx
  on rent_reminder_batches (kind, created_at desc);
