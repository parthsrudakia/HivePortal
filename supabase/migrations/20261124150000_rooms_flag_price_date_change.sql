-- A price or availability-date change on a listed room means its ads are now
-- wrong, so the room is flagged "Price/date" (listing_action =
-- 'update_price_or_date' — the yellow row on /inventory) automatically.
-- Enforced here so every write path (inventory page, Telegram bots, move-out
-- edits, scripts) gets the same result.
--
-- Rules:
--   * only base_rent, bundle_fee (together the generated total_rent) and
--     available_from count;
--   * the room must be in inventory both before and after the write — a room
--     entering inventory is a new listing with nothing posted yet, and one
--     leaving it has nothing left to update;
--   * only a room on "No action" is flagged; Delete, Boost and Priority are
--     never overwritten.
-- Someone sets the room back to "No action" once the ads match.

create or replace function public.rooms_flag_price_date_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  today date := (now() at time zone 'America/New_York')::date;
begin
  if new.listing_action <> 'no_action' then
    return new;
  end if;
  if new.base_rent is not distinct from old.base_rent
     and new.bundle_fee is not distinct from old.bundle_fee
     and new.available_from is not distinct from old.available_from then
    return new;
  end if;
  -- Same "listable right now" rule as the /inventory page.
  if not coalesce(old.pending_tenant, false)
     and coalesce(old.status = 'available'
                  or (old.status = 'occupied' and old.available_from >= today), false)
     and not coalesce(new.pending_tenant, false)
     and coalesce(new.status = 'available'
                  or (new.status = 'occupied' and new.available_from >= today), false)
  then
    new.listing_action := 'update_price_or_date';
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_flag_price_date_change on public.rooms;
create trigger rooms_flag_price_date_change
  before update on public.rooms
  for each row execute function public.rooms_flag_price_date_change();
