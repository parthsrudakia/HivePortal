-- Retire the "tool_login" and "marketing" credential categories.
-- Postgres can't drop a value from an enum in place, so rebuild the type with
-- only the surviving values. Safe because no credentials rows use either value
-- and credentials.category is the only column referencing the enum.

alter type credential_category rename to credential_category_old;

create type credential_category as enum (
  'payment_portal',
  'maintenance_portal',
  'utility',
  'internet',
  'building_login',
  'other'
);

alter table credentials
  alter column category type credential_category
  using category::text::credential_category;

drop type credential_category_old;
