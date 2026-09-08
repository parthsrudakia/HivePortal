-- Retire Courtyard, Parking Garage and Swimming Pool from the building
-- amenity taxonomy (src/lib/amenities.ts). Strip them from stored arrays so
-- inventory tags, the inventory API and the sheet export stop surfacing them.
update properties
set building_amenities = array_remove(
  array_remove(array_remove(building_amenities, 'Courtyard'), 'Parking Garage'),
  'Swimming Pool'
)
where building_amenities && array['Courtyard', 'Parking Garage', 'Swimming Pool'];
