-- A named building is identified in the UI by name + apartment number
-- ("Singh Tower Apt 901") — that pair is what distinguishes one unit from
-- another on every screen, so it has to be unique on its own. Address
-- uniqueness alone does not cover it: 626 and 628 Summit Ave were two rows
-- with the same building name AND the same unit 901, which rendered as the
-- same label and read as one apartment with five open rooms.
--
-- Partial: the 12 rows with no building name fall back to the street address
-- in unitLabel(), and properties_address_unit_unique already covers those.

create unique index properties_building_unit_unique
  on properties (lower(btrim(building_name)), lower(btrim(unit_number)))
  where building_name is not null and btrim(building_name) <> '';
