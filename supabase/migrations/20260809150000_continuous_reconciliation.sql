-- Continuous reconciliation: one consolidated recon replaces per-month runs.
--
-- Statements upload incrementally (reconciliation_statements); deposits form a
-- permanent global transaction log deduped by external_ref; matched deposits
-- post to payments IMMEDIATELY (no month window, no explicit Post step), so a
-- deposit can be assigned to a tenancy that starts after the deposit's month
-- (prepayment) and still reach the ledger. Deposit lifecycle is derived, never
-- stored: payment_id set = posted, dismissed_at set = dismissed, else
-- unassigned. payments.external_ref's global unique index remains the ledger
-- dedupe; run totals/snapshots are discarded as fully re-derivable.
--
-- Precondition (verified before applying): every reconciliation_run is posted.
-- payments rows are never inserted, updated, or deleted by this migration.

-- Refuse to run if an unposted preview run slipped in since the check.
do $$
begin
  if exists (select 1 from public.reconciliation_runs where posted_at is null) then
    raise exception 'unposted reconciliation runs exist - post or delete them first';
  end if;
end $$;

-- 1. One row per uploaded statement file.
create table public.reconciliation_statements (
  id               uuid primary key default gen_random_uuid(),
  file_path        text not null,       -- object in the 'reconciliation' bucket
  file_name        text,
  source           text not null default 'bank' check (source in ('bank', 'other')),
  parsed_row_count integer,
  deposit_count    integer,             -- NEW deposits this upload contributed
  duplicate_count  integer,             -- rows skipped as already known
  min_deposit_date date,
  max_deposit_date date,                -- "covers through" date for the UI
  note             text,
  uploaded_by      text,
  created_at       timestamptz not null default now()
);

create index reconciliation_statements_created_idx
  on public.reconciliation_statements (created_at desc);

alter table public.reconciliation_statements enable row level security;
create policy "financial operators select recon statements"
  on public.reconciliation_statements for select to authenticated
  using ((select public.is_financial_operator()));
create policy "financial operators insert recon statements"
  on public.reconciliation_statements for insert to authenticated
  with check ((select public.is_financial_operator()));
create policy "financial operators update recon statements"
  on public.reconciliation_statements for update to authenticated
  using ((select public.is_financial_operator()))
  with check ((select public.is_financial_operator()));
create policy "financial operators delete recon statements"
  on public.reconciliation_statements for delete to authenticated
  using ((select public.is_financial_operator()));

create trigger audit_reconciliation_statements
  after insert or update or delete on public.reconciliation_statements
  for each row execute function public.audit_log_trigger();

-- 2. Deposits become the permanent global transaction log.
alter table public.reconciliation_deposits
  add column statement_id uuid references public.reconciliation_statements(id) on delete restrict,
  add column dismissed_at timestamptz,
  add column dismissed_by text,
  add constraint reconciliation_deposits_not_posted_and_dismissed
    check (dismissed_at is null or payment_id is null);

-- 3. Fold each run's uploaded files into statement rows and re-point deposits.
alter table public.reconciliation_statements add column migrated_run_id uuid;

insert into public.reconciliation_statements
    (file_path, source, note, created_at, migrated_run_id)
select bank_statement_path, 'bank',
       'Migrated from ' || to_char(month, 'FMMonth YYYY') || ' run.'
         || coalesce(' ' || notes, ''),
       created_at, id
  from public.reconciliation_runs
 where bank_statement_path is not null;

insert into public.reconciliation_statements
    (file_path, source, note, created_at, migrated_run_id)
select other_payments_path, 'other',
       'Migrated from ' || to_char(month, 'FMMonth YYYY') || ' run (other payments).',
       created_at, id
  from public.reconciliation_runs
 where other_payments_path is not null;

update public.reconciliation_deposits d
   set statement_id = s.id
  from public.reconciliation_statements s
 where s.migrated_run_id = d.run_id
   and s.source = case when d.external_ref like 'other:%' then 'other' else 'bank' end;

-- Safety net: any deposit still unlinked attaches to its run's bank statement.
update public.reconciliation_deposits d
   set statement_id = s.id
  from public.reconciliation_statements s
 where d.statement_id is null
   and s.migrated_run_id = d.run_id
   and s.source = 'bank';

update public.reconciliation_statements s
   set min_deposit_date = agg.mn,
       max_deposit_date = agg.mx,
       deposit_count    = agg.n
  from (select statement_id, min(deposit_date) mn, max(deposit_date) mx, count(*) n
          from public.reconciliation_deposits
         group by statement_id) agg
 where agg.statement_id = s.id;

alter table public.reconciliation_statements drop column migrated_run_id;

-- 4. Global external_ref dedupe replaces the per-run trigger. Keep the posted
-- row, else the oldest (verified: currently zero duplicate refs exist).
delete from public.reconciliation_deposits d
 using (select id, row_number() over (
          partition by external_ref
          order by (payment_id is not null) desc, created_at, id) rn
          from public.reconciliation_deposits) r
 where d.id = r.id and r.rn > 1;

drop trigger if exists reject_duplicate_reconciliation_deposit
  on public.reconciliation_deposits;
drop function if exists public.reject_duplicate_reconciliation_deposit();

create unique index reconciliation_deposits_external_ref_unique
  on public.reconciliation_deposits (external_ref);
drop index if exists reconciliation_deposits_external_ref_idx;

create index reconciliation_deposits_unassigned_idx
  on public.reconciliation_deposits (deposit_date desc)
  where payment_id is null;

-- 5. Detach and drop the run world. Ledger provenance survives in
-- payments.external_ref/notes and reconciliation_deposits.payment_id.
drop index if exists public.payments_reconciliation_run_idx;
-- The staff-insert policy pinned reconciliation_run_id to null; external_ref
-- stays the marker for bank-posted rows, so the policy keeps its meaning
-- without the dropped column.
drop policy "staff insert ordinary payments" on public.payments;
alter table public.payments drop column reconciliation_run_id;
create policy "staff insert ordinary payments"
  on public.payments for insert to authenticated
  with check (
    amount > 0
    and paid_on <= current_date
    and payment_type <> 'refund'
    and external_ref is null
  );
alter table public.reconciliation_reversals drop column run_id;
alter table public.reconciliation_deposits drop column run_id;

drop function if exists public.post_reconciliation_run(uuid);
drop function if exists public.unpost_reconciliation_run(uuid);
drop function if exists public.delete_reconciliation_run(uuid);
drop function if exists public.replace_reconciliation_snapshot(
  uuid, jsonb, jsonb, jsonb, numeric, numeric, integer, integer, integer, boolean);

drop table public.reconciliation_matches;
drop table public.reconciliation_runs;

-- 6. Reversal resolution loses its run_id (alerts are global now).
create or replace function public.resolve_reconciliation_reversal(
  p_reversal_id uuid,
  p_mode text,
  p_resolved_by text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_reversal public.reconciliation_reversals%rowtype;
  v_suspect public.payments%rowtype;
  v_existing public.payments%rowtype;
  v_refund_id uuid;
begin
  if not public.is_financial_operator() then raise exception 'forbidden'; end if;
  if p_mode not in ('refund', 'dismiss') then raise exception 'invalid mode'; end if;

  select * into v_reversal
    from public.reconciliation_reversals
   where id = p_reversal_id
   for update;
  if not found then raise exception 'reversal not found'; end if;
  if v_reversal.resolved_at is not null then
    return jsonb_build_object(
      'amount', v_reversal.amount,
      'already_resolved', true
    );
  end if;

  if p_mode = 'refund' then
    if v_reversal.suspect_payment_id is null then
      raise exception 'no matching posted payment found for this reversal';
    end if;
    select * into v_suspect
      from public.payments
     where id = v_reversal.suspect_payment_id
     for update;
    if not found then raise exception 'the suspected payment no longer exists'; end if;
    if v_reversal.deposit_date is null or v_reversal.deposit_date > current_date then
      raise exception 'reversal has an invalid refund date';
    end if;

    select * into v_existing
      from public.payments
     where external_ref = v_reversal.external_ref
     for update;
    if found then
      if v_existing.payment_type <> 'refund'
         or v_existing.tenancy_id <> v_suspect.tenancy_id
         or v_existing.amount <> v_reversal.amount
         or v_existing.paid_on <> v_reversal.deposit_date then
        raise exception 'reversal external reference conflicts with an existing payment';
      end if;
      v_refund_id := v_existing.id;
    else
      insert into public.payments(
        tenancy_id, paid_on, amount, payment_type, method, notes, external_ref
      ) values (
        v_suspect.tenancy_id,
        v_reversal.deposit_date,
        v_reversal.amount,
        'refund',
        'Reconciliation',
        'Zelle reversal (' || left(v_reversal.raw_description, 120) || ')',
        v_reversal.external_ref
      ) returning id into v_refund_id;
    end if;
  end if;

  update public.reconciliation_reversals
     set resolved_at = now(),
         resolved_by = p_resolved_by,
         resolution = case when p_mode = 'refund' then 'refunded' else 'dismissed' end,
         refund_payment_id = v_refund_id
   where id = p_reversal_id;

  return jsonb_build_object(
    'amount', v_reversal.amount,
    'already_resolved', false,
    'refund_payment_id', v_refund_id
  );
end;
$$;

-- 7. Ingest one uploaded statement: statement row + deposits (deduped by the
-- global external_ref index) + immediate posting of auto-matched deposits.
-- All-or-nothing: a genuine external_ref conflict rolls back the whole upload.
create function public.ingest_reconciliation_statement(
  p_statement jsonb,
  p_deposits jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_statement_id uuid;
  v_dep jsonb;
  v_deposit_id uuid;
  v_tenancy_id uuid;
  v_external_ref text;
  v_amount numeric;
  v_date date;
  v_payment public.payments%rowtype;
  v_payment_id uuid;
  v_inserted integer := 0;
  v_duplicates integer := 0;
  v_posted integer := 0;
  v_min date;
  v_max date;
begin
  if not public.is_financial_operator() then raise exception 'forbidden'; end if;

  select min((d->>'deposit_date')::date), max((d->>'deposit_date')::date)
    into v_min, v_max
    from jsonb_array_elements(p_deposits) d;

  insert into public.reconciliation_statements(
    file_path, file_name, source, parsed_row_count, note, uploaded_by,
    min_deposit_date, max_deposit_date
  ) values (
    p_statement->>'file_path',
    p_statement->>'file_name',
    coalesce(p_statement->>'source', 'bank'),
    nullif(p_statement->>'parsed_row_count', '')::integer,
    nullif(p_statement->>'note', ''),
    nullif(p_statement->>'uploaded_by', ''),
    v_min,
    v_max
  ) returning id into v_statement_id;

  for v_dep in select * from jsonb_array_elements(p_deposits)
  loop
    v_external_ref := v_dep->>'external_ref';
    v_amount := (v_dep->>'amount')::numeric;
    v_date := (v_dep->>'deposit_date')::date;
    v_tenancy_id := nullif(v_dep->>'tenancy_id', '')::uuid;

    if v_date is null or v_date > current_date then
      raise exception 'deposit % has an invalid date', v_external_ref;
    end if;

    insert into public.reconciliation_deposits(
      statement_id, external_ref, payer_key, raw_description,
      amount, deposit_date, tenancy_id
    ) values (
      v_statement_id, v_external_ref, v_dep->>'payer_key',
      v_dep->>'raw_description', v_amount, v_date, v_tenancy_id
    )
    on conflict (external_ref) do nothing
    returning id into v_deposit_id;

    if v_deposit_id is null then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_inserted := v_inserted + 1;

    -- Auto-matched deposits post to the ledger immediately. The only date
    -- guard is "not in the future" — a deposit may legitimately precede its
    -- tenancy's start (prepayment).
    if v_tenancy_id is not null then
      select * into v_payment
        from public.payments
       where external_ref = v_external_ref
       for update;
      if found then
        if v_payment.amount <> v_amount
           or v_payment.paid_on <> v_date
           or v_payment.payment_type <> 'rent' then
          raise exception 'external reference % conflicts with an existing payment',
            v_external_ref;
        end if;
        v_payment_id := v_payment.id;
        if v_payment.tenancy_id is distinct from v_tenancy_id then
          update public.payments set tenancy_id = v_tenancy_id
           where id = v_payment_id;
        end if;
      else
        insert into public.payments(
          tenancy_id, paid_on, amount, payment_type, method, notes, external_ref
        ) values (
          v_tenancy_id, v_date, v_amount, 'rent', 'Reconciliation',
          'Posted from recon (' || v_external_ref || ')', v_external_ref
        ) returning id into v_payment_id;
      end if;

      update public.reconciliation_deposits
         set payment_id = v_payment_id
       where id = v_deposit_id;
      v_posted := v_posted + 1;
    end if;

    v_deposit_id := null;
  end loop;

  update public.reconciliation_statements
     set deposit_count = v_inserted,
         duplicate_count = v_duplicates
   where id = v_statement_id;

  return jsonb_build_object(
    'statement_id', v_statement_id,
    'inserted', v_inserted,
    'duplicates', v_duplicates,
    'posted', v_posted
  );
end;
$$;

-- 8. Explicit assignment: post one deposit to a tenancy, NOW. No tenancy
-- start-date or month checks — assigning a July deposit to a tenancy that
-- starts in September is a prepayment and must post.
create function public.post_reconciliation_deposit(
  p_deposit_id uuid,
  p_tenancy_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_deposit public.reconciliation_deposits%rowtype;
  v_payment public.payments%rowtype;
  v_payment_id uuid;
begin
  if not public.is_financial_operator() then raise exception 'forbidden'; end if;

  select * into v_deposit
    from public.reconciliation_deposits
   where id = p_deposit_id
   for update;
  if not found then raise exception 'deposit not found'; end if;
  if not exists (select 1 from public.tenancies where id = p_tenancy_id) then
    raise exception 'tenancy not found';
  end if;
  if v_deposit.deposit_date is null or v_deposit.deposit_date > current_date then
    raise exception 'deposit has an invalid date';
  end if;

  if v_deposit.payment_id is not null then
    -- Reassignment: re-point the existing payment.
    update public.payments
       set tenancy_id = p_tenancy_id
     where id = v_deposit.payment_id;
    v_payment_id := v_deposit.payment_id;
  else
    select * into v_payment
      from public.payments
     where external_ref = v_deposit.external_ref
     for update;
    if found then
      if v_payment.amount <> v_deposit.amount
         or v_payment.paid_on <> v_deposit.deposit_date
         or v_payment.payment_type <> 'rent' then
        raise exception 'external reference % conflicts with an existing payment',
          v_deposit.external_ref;
      end if;
      v_payment_id := v_payment.id;
      if v_payment.tenancy_id is distinct from p_tenancy_id then
        update public.payments set tenancy_id = p_tenancy_id
         where id = v_payment_id;
      end if;
    else
      insert into public.payments(
        tenancy_id, paid_on, amount, payment_type, method, notes, external_ref
      ) values (
        p_tenancy_id, v_deposit.deposit_date, v_deposit.amount,
        'rent', 'Reconciliation',
        'Posted from recon (' || v_deposit.external_ref || ')',
        v_deposit.external_ref
      ) returning id into v_payment_id;
    end if;
  end if;

  update public.reconciliation_deposits
     set tenancy_id = p_tenancy_id,
         payment_id = v_payment_id,
         dismissed_at = null,
         dismissed_by = null
   where id = p_deposit_id;

  return v_payment_id;
end;
$$;

revoke all on function public.ingest_reconciliation_statement(jsonb, jsonb)
  from public, anon;
grant execute on function public.ingest_reconciliation_statement(jsonb, jsonb)
  to authenticated, service_role;
revoke all on function public.post_reconciliation_deposit(uuid, uuid)
  from public, anon;
grant execute on function public.post_reconciliation_deposit(uuid, uuid)
  to authenticated, service_role;
