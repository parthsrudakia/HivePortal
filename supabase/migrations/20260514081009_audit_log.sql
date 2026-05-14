-- Generic audit log: every insert / update / delete on the operational
-- tables drops a row here, tagged with the authenticated user's id and
-- email (or null for service-role / cron writes).

create table audit_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid,
  user_email        text,
  action            text not null check (action in ('insert', 'update', 'delete')),
  table_name        text not null,
  record_id         text,
  before_data       jsonb,
  after_data        jsonb,
  changed_columns   text[],
  created_at        timestamptz not null default now()
);

create index audit_log_created_at_idx on audit_log (created_at desc);
create index audit_log_table_name_idx on audit_log (table_name);
create index audit_log_user_id_idx    on audit_log (user_id);

alter table audit_log enable row level security;
-- Reads are app-gated to the master user; allow any authenticated client
-- to select so the page can render. (Writes happen via the SECURITY DEFINER
-- trigger function below, which bypasses RLS by design.)
create policy "authenticated read audit_log"
  on audit_log for select to authenticated using (true);


-- Shared trigger function. Resolves the acting user from the JWT (if any),
-- diffs old vs new for UPDATEs, and inserts a row into audit_log.
create or replace function public.audit_log_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id        uuid;
  v_user_email     text;
  v_changed_cols   text[];
  v_before         jsonb;
  v_after          jsonb;
  v_record_id      text;
begin
  begin
    v_user_id := auth.uid();
  exception when others then
    v_user_id := null;
  end;
  begin
    v_user_email := auth.jwt() ->> 'email';
  exception when others then
    v_user_email := null;
  end;

  if TG_OP = 'INSERT' then
    v_after := to_jsonb(NEW);
    v_record_id := v_after ->> 'id';
  elsif TG_OP = 'UPDATE' then
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_record_id := v_after ->> 'id';
    select array_agg(key)
      into v_changed_cols
      from jsonb_each(v_before) old_kv
      join jsonb_each(v_after)  new_kv using (key)
     where old_kv.value is distinct from new_kv.value;
    -- No-op updates (e.g. set status to same value) are skipped.
    if v_changed_cols is null then
      return NEW;
    end if;
  elsif TG_OP = 'DELETE' then
    v_before := to_jsonb(OLD);
    v_record_id := v_before ->> 'id';
  end if;

  insert into audit_log(
    user_id, user_email, action, table_name, record_id,
    before_data, after_data, changed_columns
  )
  values (
    v_user_id, v_user_email, lower(TG_OP), TG_TABLE_NAME, v_record_id,
    v_before, v_after, v_changed_cols
  );

  return coalesce(NEW, OLD);
end;
$$;


-- Attach trigger to each operational table. (Skipping rent_reminder_emails,
-- room_change_events, telegram_chat_messages — those *are* audit-like
-- tables themselves.)
create trigger audit_properties              after insert or update or delete on properties              for each row execute function public.audit_log_trigger();
create trigger audit_rooms                   after insert or update or delete on rooms                   for each row execute function public.audit_log_trigger();
create trigger audit_tenants                 after insert or update or delete on tenants                 for each row execute function public.audit_log_trigger();
create trigger audit_tenancies               after insert or update or delete on tenancies               for each row execute function public.audit_log_trigger();
create trigger audit_payments                after insert or update or delete on payments                for each row execute function public.audit_log_trigger();
create trigger audit_cleaning_records        after insert or update or delete on cleaning_records        for each row execute function public.audit_log_trigger();
create trigger audit_credentials             after insert or update or delete on credentials             for each row execute function public.audit_log_trigger();
create trigger audit_leaseholders            after insert or update or delete on leaseholders            for each row execute function public.audit_log_trigger();
create trigger audit_cleaners                after insert or update or delete on cleaners                for each row execute function public.audit_log_trigger();
create trigger audit_notification_recipients after insert or update or delete on notification_recipients for each row execute function public.audit_log_trigger();
