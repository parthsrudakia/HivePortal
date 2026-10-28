-- Facebook ads default to on for rooms in non-New York units, off for New
-- York ones. New rooms take the default here; rooms re-entering inventory get
-- it from the app (freshListingFacebookAds in src/lib/facebook-ads.ts).
-- Named so it runs before rooms_delete_listing_clears_facebook_ads, which
-- still forces ads off for a room marked Delete.

create or replace function public.rooms_default_facebook_ads()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select not p.is_new_york
    into new.facebook_ads
    from public.properties p
   where p.id = new.property_id;
  new.facebook_ads := coalesce(new.facebook_ads, false);
  return new;
end;
$$;

drop trigger if exists rooms_default_facebook_ads on public.rooms;
create trigger rooms_default_facebook_ads
  before insert on public.rooms
  for each row execute function public.rooms_default_facebook_ads();
