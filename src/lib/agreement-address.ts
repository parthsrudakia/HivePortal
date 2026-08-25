/**
 * Composing a full mailing address for a property row — shared by the
 * Telegram bot's resolve_property_address tool and the /agreements page's
 * property picker, so both offer the same address for the same unit.
 */

// City lookup for composing a full mailing address. Every NY unit is New
// York, NY; NJ units are identified by their neighborhood tag.
const NJ_NEIGHBORHOOD_CITY: Record<string, string> = {
  hoboken: "Hoboken",
  jsq: "Jersey City",
  "journal square": "Jersey City",
  "jersey city heights": "Jersey City",
  "the heights": "Jersey City",
};

export function composeFullAddress(p: {
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  is_new_york: boolean | null;
}): { full_address: string; needs_city_state: boolean } {
  // Some street_address values already carry city/state ("505 Summit Ave,
  // Jersey City, NJ 07306") — slot the Apt in after the street part.
  if (/,\s*[A-Za-z .]+,\s*[A-Z]{2}\b/.test(p.street_address)) {
    const [street, ...rest] = p.street_address.split(",");
    return {
      full_address: `${street.trim()}, Apt ${p.unit_number}, ${rest
        .join(",")
        .trim()}`,
      needs_city_state: false,
    };
  }
  const base = `${p.street_address}, Apt ${p.unit_number}`;
  if (p.is_new_york) {
    return { full_address: `${base}, New York, NY`, needs_city_state: false };
  }
  const city = NJ_NEIGHBORHOOD_CITY[(p.neighborhood ?? "").trim().toLowerCase()];
  if (city) {
    return { full_address: `${base}, ${city}, NJ`, needs_city_state: false };
  }
  return { full_address: base, needs_city_state: true };
}
