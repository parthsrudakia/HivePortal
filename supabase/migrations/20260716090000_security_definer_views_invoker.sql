-- C1 (CRITICAL): v_room_occupancy and v_current_month_status were SECURITY
-- DEFINER views that bypassed RLS, and `anon` held SELECT on them — so anyone
-- with the public anon key could read all tenant PII (name, email, phone,
-- address, rent, balance) over the REST API with no login.
--
-- Fix: make the views honour the querying user's RLS (security_invoker) and
-- revoke the anon grant outright. Authenticated staff still read them (the
-- base tables have `using(true)` SELECT policies for authenticated).

alter view public.v_room_occupancy set (security_invoker = on);
alter view public.v_current_month_status set (security_invoker = on);

revoke select on public.v_room_occupancy from anon;
revoke select on public.v_current_month_status from anon;
