-- L2: audit_log_trigger() and rls_auto_enable() are SECURITY DEFINER functions
-- that were EXECUTE-able by anon/authenticated over /rest/v1/rpc. They only do
-- anything as (event) triggers and error if called directly, but there's no
-- reason to expose them on the API — revoke EXECUTE. The triggers themselves run
-- as the table owner and are unaffected.

revoke all on function public.audit_log_trigger() from public, anon, authenticated;
revoke all on function public.rls_auto_enable()  from public, anon, authenticated;
