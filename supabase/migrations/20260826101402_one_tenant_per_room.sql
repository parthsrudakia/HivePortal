-- A room holds one tenant at a time. The app already enforces this via
-- findRoomClash (src/lib/tenancy-create.ts), but bulk imports / direct SQL
-- bypass it — enforce the same slot rule in the database:
--   * at most one ACTIVE tenancy per room (the current occupant)
--   * at most one UPCOMING tenancy per room (the reserved slot)
-- An active + an upcoming on the same room is the legitimate back-to-back
-- turnover the daily lifecycle cron handles, so that stays allowed.

create unique index if not exists tenancies_one_active_per_room
  on public.tenancies (room_id)
  where status = 'active' and room_id is not null;

create unique index if not exists tenancies_one_upcoming_per_room
  on public.tenancies (room_id)
  where status = 'upcoming' and room_id is not null;
