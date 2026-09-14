-- A room marked "Delete" (listing_action = 'delete_listing' — the red row on
-- /inventory) is coming off the market, so its Facebook ads must be off.
-- Enforced here so every write path (portal action, Telegram bot, scripts)
-- gets the same result: setting the action to delete_listing turns the ads
-- off, and ads cannot be turned on while the room stays marked Delete.

create or replace function public.rooms_delete_listing_clears_facebook_ads()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.listing_action = 'delete_listing' then
    new.facebook_ads := false;
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_delete_listing_clears_facebook_ads on public.rooms;
create trigger rooms_delete_listing_clears_facebook_ads
  before insert or update of listing_action, facebook_ads on public.rooms
  for each row execute function public.rooms_delete_listing_clears_facebook_ads();

-- Backfill: rooms already marked Delete with ads still on.
update public.rooms
   set facebook_ads = false
 where listing_action = 'delete_listing'
   and facebook_ads;
