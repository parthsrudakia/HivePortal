-- L5: set a fixed search_path on the two flagged functions so they can't be
-- hijacked by a role-local search_path (function_search_path_mutable). Both
-- bodies use only built-ins / their own arguments, so an empty search_path is
-- safe. (The other L5 items — Postgres leaked-password protection and the
-- telegram_updates "RLS enabled, no policy" INFO notice — are handled outside
-- migrations: leaked-password protection is an Auth setting toggled in the
-- Supabase dashboard, and telegram_updates is intentionally locked to the
-- service role, which is already the secure state.)

alter function public.set_updated_at() set search_path = '';
alter function public.property_display_name(text, text, text) set search_path = '';
