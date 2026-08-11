-- Per-user conversation history for the in-portal ops-assistant widget.
-- Separate from telegram_chat_messages: different surface, different auth
-- domain (portal user_id vs Telegram chat_id). Service-role only — the
-- /api/assistant route authorizes the operator and reads/writes on their
-- behalf, mirroring how the telegram webhook owns telegram_chat_messages.
create table if not exists public.assistant_chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_chat_messages_user_idx
  on public.assistant_chat_messages (user_id, created_at);

alter table public.assistant_chat_messages enable row level security;
-- No policies: authenticated/anon get nothing; only the service-role client
-- (used by the assistant route) can read or write. Also keep it off the
-- bot's own query_database surface — it is not in that whitelist.
