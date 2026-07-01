-- Diagnostic activity log for the Telegram ops bot. Unlike telegram_chat_messages
-- (which only stores the final user/assistant text so the bot can rebuild context),
-- this table records EVERYTHING needed to investigate what the bot did and why a
-- turn went wrong: each tool call with its inputs, result, ok flag, latency and any
-- error; the agent's token usage; and agent-level errors that never reach the DB
-- otherwise. Rows for one user turn share a turn_id so the whole exchange can be
-- reconstructed in order.
--
--   kind     — user_message | assistant_reply | tool_call | agent_error
--              | slash_command | rejected
--   tool_name, ok, latency_ms, error — populated for tool_call / assistant_reply
--   text     — human-readable summary (the user's text, the reply, the error)
--   detail   — structured payload (tool input + result, model usage, stop reason)
--
-- Written by logTelegramEvent() with the service role, so no write policy is
-- needed; authenticated users may read (the settings page gates the clear action
-- to the master operator).
create table telegram_activity_log (
  id               bigserial primary key,
  turn_id          uuid,
  chat_id          bigint not null,
  telegram_user_id bigint,
  username         text,
  kind             text not null check (
    kind in (
      'user_message',
      'assistant_reply',
      'tool_call',
      'agent_error',
      'slash_command',
      'rejected'
    )
  ),
  tool_name        text,
  ok               boolean,
  latency_ms       integer,
  error            text,
  text             text,
  detail           jsonb,
  created_at       timestamptz not null default now()
);

alter table telegram_activity_log enable row level security;
create policy "authenticated read telegram_activity_log"
  on telegram_activity_log for select to authenticated using (true);

create index telegram_activity_log_created_at_idx
  on telegram_activity_log (created_at desc);
create index telegram_activity_log_chat_idx
  on telegram_activity_log (chat_id, created_at desc);
create index telegram_activity_log_turn_idx
  on telegram_activity_log (turn_id, created_at);
create index telegram_activity_log_kind_idx
  on telegram_activity_log (kind, created_at desc);
