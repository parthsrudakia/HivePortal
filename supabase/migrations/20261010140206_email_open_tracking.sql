-- Email open tracking. Every HTML email the portal sends (Resend + Outlook)
-- carries a 1x1 pixel at <EMAIL_TRACKING_ORIGIN>/api/o/<track_id>; loading it
-- calls record_email_open, which stamps the first/last open and counts opens
-- on that email's log row. Plain-text sends (NY Gmail) have no track_id.
-- Opens are approximate: Apple Mail pre-loads images (false opens) and many
-- clients block images until the reader allows them (missed opens). A bulk
-- BCC blast is one row, so its opens can't say which recipient opened.
alter table public.email_log
  add column track_id uuid,
  add column opened_at timestamptz,
  add column last_opened_at timestamptz,
  add column open_count integer not null default 0;

create unique index email_log_track_id_idx on public.email_log (track_id) where track_id is not null;

-- Called by the public pixel route with the service role only.
create or replace function public.record_email_open(p_track_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.email_log
     set open_count = open_count + 1,
         opened_at = coalesce(opened_at, now()),
         last_opened_at = now()
   where track_id = p_track_id;
$$;

revoke all on function public.record_email_open(uuid) from public, anon, authenticated;
grant execute on function public.record_email_open(uuid) to service_role;
