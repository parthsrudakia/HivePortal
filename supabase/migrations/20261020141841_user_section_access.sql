-- Per-user portal section access, managed by the master operator (Vineet)
-- from Settings → Access control. A row lists the sections a user is BLOCKED
-- from; no row (or an empty array) means full access, so existing and newly
-- invited users keep today's behaviour until Vineet restricts them.
-- Section keys mirror PORTAL_SECTIONS in src/lib/section-access.ts.
create table public.user_section_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  blocked_sections text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.user_section_access enable row level security;

-- Users may read their own row (the portal gates nav + pages with it).
-- Writes go through the service role after an isMaster() check in the
-- server action — no write policy for authenticated users.
create policy "read own section access" on public.user_section_access
  for select to authenticated
  using (user_id = (select auth.uid()));
