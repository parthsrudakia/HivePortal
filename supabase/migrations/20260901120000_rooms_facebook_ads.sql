-- Whether Facebook ads are running for this room's listing. Off by default;
-- reset to off whenever a room (re)enters inventory (fresh vacancy cycle).
alter table public.rooms
  add column facebook_ads boolean not null default false;
