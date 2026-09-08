/**
 * Canonical amenity taxonomy. Amenities live on `properties` as two text[]
 * columns (`unit_amenities`, `building_amenities`) whose values must come
 * from these lists — normalize any form input through the helpers below so
 * stored arrays stay deduped and in canonical order.
 */

export const UNIT_AMENITIES = [
  "High-Speed WiFi",
  "Central A/C",
  "In-Unit Washer/Dryer",
  "Fully Equipped Kitchen",
  "Dishwasher",
] as const;

export const BUILDING_AMENITIES = [
  "24/7 Doorman",
  "Fitness Center",
  "Rooftop Terrace",
  "Package Room",
  "Laundry Room",
  "Elevator",
  "Lounge",
] as const;

export type UnitAmenity = (typeof UNIT_AMENITIES)[number];
export type BuildingAmenity = (typeof BUILDING_AMENITIES)[number];

export function normalizeUnitAmenities(values: string[]): UnitAmenity[] {
  return UNIT_AMENITIES.filter((a) => values.includes(a));
}

export function normalizeBuildingAmenities(values: string[]): BuildingAmenity[] {
  return BUILDING_AMENITIES.filter((a) => values.includes(a));
}
