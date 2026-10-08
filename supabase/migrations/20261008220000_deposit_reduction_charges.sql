-- A security deposit can shrink after it was collected: a room transfer to a
-- cheaper room, or part of the deposit applied to rent by agreement. That is a
-- NEGATIVE 'security_deposit' charge — it lowers the deposit bucket's owed
-- total (so the tenant page's "Security deposit" figure is the deposit
-- actually held) and credits the running balance by the same amount. Posting
-- it as a generic 'adjustment' credited the balance but left the deposit
-- total stuck at the original amount.

alter table public.tenancy_charges
  drop constraint tenancy_charges_amount_check;
alter table public.tenancy_charges
  add constraint tenancy_charges_amount_check check (
    case when kind in ('adjustment', 'security_deposit') then amount <> 0 else amount > 0 end
  );
