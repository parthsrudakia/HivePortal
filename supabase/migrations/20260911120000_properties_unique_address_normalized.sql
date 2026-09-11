-- A unit is identified by its street address + apartment number, and the old
-- UNIQUE (street_address, unit_number) matched those byte for byte: casing or
-- a stray space was enough to let the same unit in twice. Normalize both sides
-- so "628 Summit Ave" and "628 summit ave " collide the way they should.
--
-- Both columns are NOT NULL, so there is no NULL-bypass to guard against.

alter table properties
  drop constraint if exists properties_street_address_unit_number_key;

create unique index properties_address_unit_unique
  on properties (lower(btrim(street_address)), lower(btrim(unit_number)));
