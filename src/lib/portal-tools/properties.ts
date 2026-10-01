import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { composeFullAddress } from "@/lib/agreement-address";
import {
  UNIT_AMENITIES,
  BUILDING_AMENITIES,
  normalizeUnitAmenities,
  normalizeBuildingAmenities,
} from "@/lib/amenities";
import { admin, one, propertyLabel, ISO_DATE_RE } from "./helpers";

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
  const [{ data: props, error }, { data: saved }, { data: rooms }] =
    await Promise.all([
      supabase
        .from("properties")
        .select(
          "id, building_name, street_address, unit_number, neighborhood, is_new_york",
        ),
      // Addresses the operator has already confirmed on a sent agreement —
      // these are exact and win over anything we could compose.
      supabase.from("agreement_addresses").select("property_id, full_address"),
      // send_agreement needs a room that exists at the property — list them
      // so the bot can offer / validate the room alongside the address.
      supabase
        .from("rooms")
        .select("id, property_id, room_number")
        .not("room_number", "is", null)
        .order("room_number"),
    ]);
  if (error) throw new Error(error.message);
  const roomsByProperty = new Map<string, { room_id: string; room_number: string }[]>();
  for (const r of rooms ?? []) {
    if (!r.room_number?.trim()) continue;
    roomsByProperty.set(r.property_id, [
      ...(roomsByProperty.get(r.property_id) ?? []),
      { room_id: r.id, room_number: r.room_number.trim() },
    ]);
  }
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
      // Rooms at this unit — send_agreement's room_number must be one of them.
      rooms: roomsByProperty.get(p.id) ?? [],
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

// Create a new property (apartment unit) from the bot. Mirrors the portal's
// add-property form: building, address, unit, cross street, neighborhood,
// NY flag, bedrooms and bathrooms are mandatory; everything else optional.
// Like the form, one blank room per bedroom is created for the operator to
// price later, and a named leaseholder is looked up or created.
export type CreatePropertyArgs = {
  building_name: string;
  street_address: string;
  unit_number: string;
  cross_street: string;
  neighborhood: string;
  is_new_york: boolean;
  bedrooms: number;
  bathrooms: number;
  unit_amenities?: string[];
  building_amenities?: string[];
  amenities_notes?: string;
  unit_rent?: number;
  unit_lease_start?: string;
  unit_lease_end?: string;
  amenity_fees_yearly?: number;
  misc_fees_yearly?: number;
  internet_monthly?: number;
  cleaning_fee_monthly?: number;
  insurance_monthly?: number;
  leaseholder_name?: string;
  cleaner_ids?: string[];
  notes?: string;
};

export async function createProperty(args: CreatePropertyArgs) {
  const text = (v: string | undefined) => (v ?? "").trim();
  const building_name = text(args.building_name);
  const street_address = text(args.street_address);
  const unit_number = text(args.unit_number);
  const cross_street = text(args.cross_street);
  const neighborhood = text(args.neighborhood);

  if (!building_name) throw new Error("Building name is required.");
  if (!street_address) throw new Error("Street address is required.");
  if (!unit_number) throw new Error("Unit number is required.");
  if (!cross_street) throw new Error("Cross street is required.");
  if (!neighborhood) throw new Error("Neighborhood is required.");
  if (typeof args.is_new_york !== "boolean") {
    throw new Error("Say whether the unit is in New York (is_new_york true/false).");
  }
  if (!Number.isInteger(args.bedrooms) || args.bedrooms <= 0) {
    throw new Error("Bedrooms must be a whole number greater than 0.");
  }
  if (!Number.isFinite(args.bathrooms) || args.bathrooms <= 0) {
    throw new Error("Bathrooms must be a number greater than 0.");
  }

  const money: Record<string, number | undefined> = {
    unit_rent: args.unit_rent,
    amenity_fees_yearly: args.amenity_fees_yearly,
    misc_fees_yearly: args.misc_fees_yearly,
    internet_monthly: args.internet_monthly,
    cleaning_fee_monthly: args.cleaning_fee_monthly,
    insurance_monthly: args.insurance_monthly,
  };
  for (const [field, value] of Object.entries(money)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${field.replaceAll("_", " ")} must be a non-negative number.`);
    }
  }

  const lease_start = text(args.unit_lease_start) || null;
  const lease_end = text(args.unit_lease_end) || null;
  for (const [label, value] of [
    ["Unit lease start", lease_start],
    ["Unit lease end", lease_end],
  ] as const) {
    if (value && !ISO_DATE_RE.test(value)) {
      throw new Error(`${label} must be a date in YYYY-MM-DD form.`);
    }
  }
  if (lease_start && lease_end && lease_end < lease_start) {
    throw new Error("Unit lease end date is before the start date.");
  }

  // Amenities must come from the fixed lists the portal knows; anything
  // else is reported back rather than silently dropped.
  const unknownUnit = (args.unit_amenities ?? []).filter(
    (a) => !(UNIT_AMENITIES as readonly string[]).includes(a),
  );
  const unknownBuilding = (args.building_amenities ?? []).filter(
    (a) => !(BUILDING_AMENITIES as readonly string[]).includes(a),
  );
  if (unknownUnit.length > 0 || unknownBuilding.length > 0) {
    throw new Error(
      `Unknown amenities: ${[...unknownUnit, ...unknownBuilding].join(", ")}. ` +
        `Unit options: ${UNIT_AMENITIES.join(", ")}. ` +
        `Building options: ${BUILDING_AMENITIES.join(", ")}.`,
    );
  }

  const supabase = admin();

  // Cleaners are assigned by id — verify each exists before writing.
  const cleanerIds = [...new Set((args.cleaner_ids ?? []).map((c) => c.trim()).filter(Boolean))];
  let cleanerNames: string[] = [];
  if (cleanerIds.length > 0) {
    const { data: found, error: cErr } = await supabase
      .from("cleaners")
      .select("id, name")
      .in("id", cleanerIds);
    if (cErr) throw new Error(cErr.message);
    const foundIds = new Set((found ?? []).map((c) => c.id));
    const missing = cleanerIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Unknown cleaner id(s): ${missing.join(", ")}. Use list_cleaners to find the right ids.`,
      );
    }
    cleanerNames = (found ?? []).map((c) => c.name);
  }

  // Refuse duplicates up front with a friendly message (the unique indexes
  // on street + unit would reject it anyway).
  const { data: dup } = await supabase
    .from("properties")
    .select("id")
    .ilike("street_address", street_address)
    .ilike("unit_number", unit_number)
    .maybeSingle();
  if (dup) {
    throw new Error(
      `A property at ${street_address} Apt ${unit_number} already exists (property ${dup.id}).`,
    );
  }

  // A named building is shown as "<building> Apt <unit>", so that pair must be
  // unique too — otherwise the new unit is indistinguishable from the old one
  // on every screen, whatever its street address says.
  if (building_name) {
    const { data: nameDup } = await supabase
      .from("properties")
      .select("id, street_address")
      .ilike("building_name", building_name)
      .ilike("unit_number", unit_number)
      .maybeSingle();
    if (nameDup) {
      throw new Error(
        `${building_name} Apt ${unit_number} already exists at ${nameDup.street_address} (property ${nameDup.id}). Both would show the same label.`,
      );
    }
  }

  // Leaseholder: reuse by name (case-insensitive) or create.
  let leaseholder_id: string | null = null;
  let leaseholderCreated = false;
  const leaseholderName = text(args.leaseholder_name);
  if (leaseholderName) {
    const { data: existing } = await supabase
      .from("leaseholders")
      .select("id")
      .ilike("name", leaseholderName)
      .limit(1)
      .maybeSingle();
    if (existing) {
      leaseholder_id = existing.id;
    } else {
      const { data: created, error: lErr } = await supabase
        .from("leaseholders")
        .insert({ name: leaseholderName })
        .select("id")
        .single();
      if (lErr) throw new Error(lErr.message);
      leaseholder_id = created.id;
      leaseholderCreated = true;
    }
  }

  const { data: property, error } = await supabase
    .from("properties")
    .insert({
      building_name,
      street_address,
      unit_number,
      cross_street,
      neighborhood,
      is_new_york: args.is_new_york,
      bedrooms: args.bedrooms,
      bathrooms: args.bathrooms,
      unit_amenities: normalizeUnitAmenities(args.unit_amenities ?? []),
      building_amenities: normalizeBuildingAmenities(args.building_amenities ?? []),
      amenities_notes: text(args.amenities_notes) || null,
      unit_rent: args.unit_rent ?? null,
      unit_lease_start: lease_start,
      unit_lease_end: lease_end,
      amenity_fees_yearly: args.amenity_fees_yearly ?? null,
      misc_fees_yearly: args.misc_fees_yearly ?? null,
      internet_monthly: args.internet_monthly ?? null,
      cleaning_fee_monthly: args.cleaning_fee_monthly ?? null,
      insurance_monthly: args.insurance_monthly ?? null,
      leaseholder_id,
      notes: text(args.notes) || null,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(
      error.code === "23505"
        ? "A property with that street address + unit number already exists."
        : error.message,
    );
  }

  if (cleanerIds.length > 0) {
    const { error: pcErr } = await supabase.from("property_cleaners").insert(
      cleanerIds.map((cleaner_id) => ({ property_id: property.id, cleaner_id })),
    );
    if (pcErr) throw new Error(`Property created, but assigning cleaners failed: ${pcErr.message}`);
  }

  // One blank room per bedroom, same as the portal form.
  const roomNumbers = Array.from({ length: args.bedrooms }, (_, i) => `Room ${i + 1}`);
  const { error: rErr } = await supabase.from("rooms").insert(
    roomNumbers.map((room_number) => ({
      property_id: property.id,
      room_number,
      status: "available" as const,
    })),
  );
  if (rErr) throw new Error(`Property created, but creating rooms failed: ${rErr.message}`);

  return {
    ok: true,
    property_id: property.id,
    name: propertyLabel({ building_name, street_address, unit_number }),
    neighborhood,
    is_new_york: args.is_new_york,
    bedrooms: args.bedrooms,
    bathrooms: args.bathrooms,
    rooms_created: roomNumbers,
    leaseholder: leaseholderName || null,
    leaseholder_created: leaseholderCreated,
    cleaners_assigned: cleanerNames,
    note: "Rooms were created blank — set each room's rent and details next (update_room_rent or the portal).",
  };
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
      "full_address ready for send_agreement, the property's is_new_york " +
      "flag, and its rooms[] (room_id + room_number — send_agreement's " +
      "mandatory room must be one of these). When operator_confirmed is true the address was used on a " +
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
  betaZodTool({
    name: "create_property",
    description:
      "Add a new property (apartment unit) to the portal. Use when the operator " +
      "asks to add / create a new unit, apartment, or property. MANDATORY " +
      "fields — ask for any that are missing, never guess: building name, " +
      "street address, unit number, cross street, neighborhood, whether it is " +
      "in New York (yes/no), bedrooms (whole number), bathrooms. Everything " +
      "else is optional (amenities, master-lease rent and dates, yearly/monthly " +
      "fees, leaseholder, cleaners, notes) — include it only if the operator " +
      "gave it; do not ask for optional fields one by one, at most offer once. " +
      "Amenities must be chosen from the fixed lists: unit — " +
      UNIT_AMENITIES.join(", ") +
      "; building — " +
      BUILDING_AMENITIES.join(", ") +
      ". Cleaners are passed by id (use list_cleaners). This writes to the " +
      "database: read every field back and get an explicit confirmation before " +
      "calling. One blank room per bedroom is created automatically; rents " +
      "are set per room afterwards. Refuses a street address + unit that " +
      "already exists.",
    inputSchema: z.object({
      building_name: z.string().describe("Building name, e.g. MetroVue"),
      street_address: z.string().describe("Street address, e.g. 90 Washington St"),
      unit_number: z.string().describe("Unit / apartment number, e.g. 24M"),
      cross_street: z.string().describe("Nearest cross street, e.g. Washington & Wall"),
      neighborhood: z.string().describe("Neighborhood, e.g. JSQ, UWS, FiDi, Midtown"),
      is_new_york: z
        .boolean()
        .describe("true if the unit is in New York (NY agreement path, no auto late fees)"),
      bedrooms: z.number().int().positive().describe("Number of bedrooms (rooms to create)"),
      bathrooms: z.number().positive().describe("Number of bathrooms, halves allowed (e.g. 1.5)"),
      unit_amenities: z
        .array(z.string())
        .optional()
        .describe("Unit amenities from the fixed list"),
      building_amenities: z
        .array(z.string())
        .optional()
        .describe("Building amenities from the fixed list"),
      amenities_notes: z.string().optional().describe("Free-text amenity notes"),
      unit_rent: z
        .number()
        .nonnegative()
        .optional()
        .describe("Monthly rent Hive pays the landlord for the whole unit"),
      unit_lease_start: z.string().optional().describe('Master lease start "YYYY-MM-DD"'),
      unit_lease_end: z.string().optional().describe('Master lease end "YYYY-MM-DD"'),
      amenity_fees_yearly: z.number().nonnegative().optional().describe("Yearly amenity fees"),
      misc_fees_yearly: z.number().nonnegative().optional().describe("Yearly misc fees"),
      internet_monthly: z.number().nonnegative().optional().describe("Monthly internet cost"),
      cleaning_fee_monthly: z.number().nonnegative().optional().describe("Monthly cleaning fee"),
      insurance_monthly: z.number().nonnegative().optional().describe("Monthly insurance cost"),
      leaseholder_name: z
        .string()
        .optional()
        .describe("Leaseholder name (e.g. Vinny, Nehal, Suman); created if new"),
      cleaner_ids: z
        .array(z.string())
        .optional()
        .describe("UUIDs of cleaners to assign (from list_cleaners)"),
      notes: z.string().optional().describe("Free-form notes about the property"),
    }),
    run: async (args) => JSON.stringify(await createProperty(args)),
  }),
];
