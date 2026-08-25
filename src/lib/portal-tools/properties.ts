import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { composeFullAddress } from "@/lib/agreement-address";
import { admin, one, propertyLabel } from "./helpers";

export async function listProperties() {
  const supabase = admin();
  const { data, error } = await supabase
    .from("properties")
    .select(
      `id, building_name, street_address, unit_number, neighborhood, bedrooms,
       leaseholders(name),
       rooms(id, status)`,
    )
    .order("street_address");
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({
    id: p.id,
    name: propertyLabel(p),
    neighborhood: p.neighborhood,
    bedrooms: p.bedrooms,
    leaseholder: one(p.leaseholders)?.name ?? null,
    rooms_total: p.rooms?.length ?? 0,
    rooms_available:
      p.rooms?.filter((r) => r.status === "available").length ?? 0,
  }));
}

export async function getProperty(id: string) {
  const supabase = admin();
  const { data: property, error: pErr } = await supabase
    .from("properties")
    .select(
      `id, building_name, street_address, unit_number, cross_street,
       neighborhood, bedrooms, bathrooms,
       unit_amenities, building_amenities, amenities_notes, notes,
       leaseholders(name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!property) throw new Error("Property not found.");

  const { data: rooms, error: rErr } = await supabase
    .from("rooms")
    .select(
      `id, room_number, has_private_bathroom, has_ac, base_rent, bundle_fee,
       total_rent, status, available_from, listing_action,
       tenancies!left(id, status, monthly_rent, start_date, move_out_date,
                      tenants(id, full_name, email, phone))`,
    )
    .eq("property_id", id);
  if (rErr) throw new Error(rErr.message);

  return {
    id: property.id,
    name: propertyLabel(property),
    address: property.street_address,
    unit_number: property.unit_number,
    cross_street: property.cross_street,
    neighborhood: property.neighborhood,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    leaseholder: one(property.leaseholders)?.name ?? null,
    amenities: {
      unit: property.unit_amenities,
      building: property.building_amenities,
      notes: property.amenities_notes,
    },
    notes: property.notes,
    rooms: (rooms ?? []).map((r) => {
      const active = (r.tenancies ?? []).find(
        (t: { status: string }) => t.status === "active",
      );
      const tenant = active ? one(active.tenants) : null;
      return {
        id: r.id,
        room_number: r.room_number,
        status: r.status,
        listing_action: r.listing_action,
        rent: { base: r.base_rent, bundle: r.bundle_fee, total: r.total_rent },
        has_private_bathroom: r.has_private_bathroom,
        has_ac: r.has_ac,
        available_from: r.available_from,
        current_tenant: active && tenant
          ? {
              id: tenant.id,
              full_name: tenant.full_name,
              email: tenant.email,
              phone: tenant.phone,
              tenancy_id: active.id,
              monthly_rent: active.monthly_rent,
              move_out_date: active.move_out_date,
            }
          : null,
      };
    }),
  };
}

// Autocomplete a property address from a fragment the operator typed
// ("3516 jfk 203", "normandie 32F", "the epic"). Matches against building
// name, street, unit, and neighborhood; returns composed full addresses
// ready for send_agreement.
export async function resolvePropertyAddress(args: { query: string }) {
  const supabase = admin();
  const [{ data: props, error }, { data: saved }] = await Promise.all([
    supabase
      .from("properties")
      .select(
        "id, building_name, street_address, unit_number, neighborhood, is_new_york",
      ),
    // Addresses the operator has already confirmed on a sent agreement —
    // these are exact and win over anything we could compose.
    supabase.from("agreement_addresses").select("property_id, full_address"),
  ]);
  if (error) throw new Error(error.message);
  const confirmedById = new Map(
    (saved ?? []).map((s) => [s.property_id as string, s.full_address as string]),
  );

  const tokens = args.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) throw new Error("Give me part of an address to match.");

  const scored = (props ?? [])
    .map((p) => {
      const hay = [
        p.building_name,
        p.street_address,
        p.unit_number,
        p.neighborhood,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return { p, hits: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((s) => s.hits > 0);

  // Prefer units matching every token; otherwise fall back to best partials
  // so a typo'd fragment still surfaces candidates to pick from.
  const full = scored.filter((s) => s.hits === tokens.length);
  const pool = (full.length > 0 ? full : scored)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5);

  return pool.map(({ p, hits }) => {
    const confirmed = confirmedById.get(p.id);
    return {
      property_id: p.id,
      label: propertyLabel(p),
      neighborhood: p.neighborhood,
      is_new_york: p.is_new_york,
      matched_all_terms: hits === tokens.length,
      ...(confirmed
        ? {
            full_address: confirmed,
            needs_city_state: false,
            // Exact address the operator confirmed on a previous agreement —
            // use verbatim, no re-composing needed.
            operator_confirmed: true,
          }
        : { ...composeFullAddress(p), operator_confirmed: false }),
    };
  });
}

export const propertiesTools = [
  betaZodTool({
    name: "list_properties",
    description:
      "List every property (apartment unit) with rooms-total / rooms-available / leaseholder.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await listProperties()),
  }),
  betaZodTool({
    name: "get_property",
    description: "Full property detail by id, including each room's current tenant.",
    inputSchema: z.object({ id: z.string().describe("UUID of the property") }),
    run: async (args) => JSON.stringify(await getProperty(args.id)),
  }),
  betaZodTool({
    name: "resolve_property_address",
    description:
      "Autocomplete a full property address from a fragment the operator " +
      "gave (building name, street, unit, or neighborhood — e.g. '3516 jfk " +
      "203' or 'normandie 32F'). Returns up to 5 matching units, each with a " +
      "full_address ready for send_agreement plus the property's is_new_york " +
      "flag. When operator_confirmed is true the address was used on a " +
      "previously sent agreement — it is exact; use it verbatim. Otherwise " +
      "full_address is composed from portal data: auto-correct it to the " +
      "exact postal address (expand abbreviated street names, add the ZIP " +
      "code if you know it) before reading it back. If needs_city_state is " +
      "true, ask the operator for the city/state. Always read the final " +
      "address back for confirmation before sending an agreement.",
    inputSchema: z.object({
      query: z.string().describe("Address fragment as the operator typed it"),
    }),
    run: async (args) => JSON.stringify(await resolvePropertyAddress(args)),
  }),
];
