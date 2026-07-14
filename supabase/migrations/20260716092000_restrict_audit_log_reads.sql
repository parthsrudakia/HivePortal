-- L3: audit/activity-log tables were readable by every authenticated user.
--   * credential_access_log — who revealed which secret (sensitive trail)
--   * telegram_chat_messages — full bot transcripts (may contain secrets)
-- Restrict SELECT on both to the two operators. Inserts are unchanged:
--   * credential_access_log keeps its authenticated INSERT policy (the web app
--     writes reveal/copy events under the user's session).
--   * telegram_chat_messages is written only by the service role (the bot),
--     which bypasses RLS, so authenticated write access is removed entirely.

-- credential_access_log: reads → owners only; keep authenticated insert.
drop policy if exists "authenticated read access log" on public.credential_access_log;
create policy "owners read access log"
  on public.credential_access_log
  for select to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );

-- telegram_chat_messages: no authenticated access at all (service role only).
drop policy if exists "authenticated read telegram chat"  on public.telegram_chat_messages;
drop policy if exists "authenticated write telegram chat" on public.telegram_chat_messages;
create policy "owners read telegram chat"
  on public.telegram_chat_messages
  for select to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', ''))
      = any (array['vdutta1485@gmail.com', 'parthrudakia@gmail.com'])
  );
