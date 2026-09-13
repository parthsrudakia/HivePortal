-- A rent change effective from month M must supersede any rent-history rows
-- scheduled for months AFTER M.
--
-- Previously update_tenancy_rent only upserted the row for M itself. Setting a
-- tenancy back to an earlier lease (e.g. reverting a $1,675 renewal effective
-- July to $1,625 effective June) rewrote the June row but left the July row in
-- place, so the ledger kept billing $1,675 from July onward while
-- tenancies.monthly_rent said $1,625. The two could never be brought back in
-- sync from the UI.
--
-- Now: rows with effective_month > M are deleted before the upsert, so the
-- history always reads "current rate applies from M onward" and matches
-- tenancies.monthly_rent for every month >= M.

create or replace function public.update_tenancy_rent(
  p_tenancy_id uuid,
  p_new_rate numeric,
  p_effective_from date,
  p_lease_start date,
  p_lease_end date
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current public.tenancies%rowtype;
  v_effective_month date;
  v_baseline_month date;
begin
  if not public.is_financial_operator() then raise exception 'forbidden'; end if;
  if p_new_rate is null or p_new_rate <= 0 then raise exception 'rent must be positive'; end if;
  if p_effective_from is null or p_lease_start is null or p_lease_end is null
     or p_lease_end <= p_lease_start then
    raise exception 'invalid lease dates';
  end if;

  select * into v_current from public.tenancies where id = p_tenancy_id for update;
  if not found then raise exception 'tenancy not found'; end if;

  v_effective_month := date_trunc('month', p_effective_from)::date;
  v_baseline_month := date_trunc('month', v_current.start_date)::date;

  -- Any change scheduled after the new effective month is superseded by it.
  -- (Also runs when the rate is unchanged, so re-saving the same rent from an
  -- earlier lease start clears stale later rows.)
  delete from public.tenancy_rent_history
   where tenancy_id = p_tenancy_id
     and effective_month > v_effective_month;

  if v_current.monthly_rent is distinct from p_new_rate then
    if not exists (
      select 1 from public.tenancy_rent_history where tenancy_id = p_tenancy_id
    ) and v_baseline_month < v_effective_month then
      insert into public.tenancy_rent_history(tenancy_id, effective_month, monthly_rent)
      values (p_tenancy_id, v_baseline_month, v_current.monthly_rent)
      on conflict (tenancy_id, effective_month) do nothing;
    end if;
  end if;

  -- Pin the rate at M whenever the rate changed or history already exists, so
  -- no month >= M can resolve to a stale earlier row.
  if v_current.monthly_rent is distinct from p_new_rate or exists (
    select 1 from public.tenancy_rent_history where tenancy_id = p_tenancy_id
  ) then
    insert into public.tenancy_rent_history(tenancy_id, effective_month, monthly_rent)
    values (p_tenancy_id, v_effective_month, p_new_rate)
    on conflict (tenancy_id, effective_month)
    do update set monthly_rent = excluded.monthly_rent
    where public.tenancy_rent_history.monthly_rent is distinct from excluded.monthly_rent;
  end if;

  update public.tenancies
     set monthly_rent = p_new_rate,
         lease_start_date = p_lease_start,
         lease_end_date = p_lease_end,
         lease_end_reminded_at = null,
         lease_end_reminded_30_at = null
   where id = p_tenancy_id;
end;
$$;
