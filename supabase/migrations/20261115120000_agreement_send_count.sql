-- Count how many times a signing request's email has gone out (the first send
-- plus every resend), so the 3rd send can also nudge a current tenant by text
-- (src/lib/agreement-nudge.ts). nudge_texted_at keeps that text to once.
alter table public.agreement_requests
  add column if not exists send_count integer not null default 1,
  add column if not exists nudge_texted_at timestamptz;
