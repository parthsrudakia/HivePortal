-- Tenants: unify linkedin_url/instagram_url into one social_links list so
-- any number of profile links can be attached. Existing values migrate in
-- (LinkedIn first, then Instagram); the old columns are dropped.
alter table public.tenants
  add column social_links text[] not null default '{}';

update public.tenants
   set social_links = array_remove(array[linkedin_url, instagram_url], null)
 where linkedin_url is not null or instagram_url is not null;

alter table public.tenants
  drop column linkedin_url,
  drop column instagram_url;
