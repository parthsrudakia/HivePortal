/**
 * Shared plumbing for the read-only inventory API
 * (`GET /api/inventory`, `GET /api/inventory/[roomId]`).
 *
 * Auth is a static bearer token (`INVENTORY_API_KEY`) for internal
 * tools/scripts — same shape as the cron routes' CRON_SECRET check. Reads use
 * the service-role client since callers have no cookie session.
 *
 * The payload is core listing data only: unit/building, neighborhood, room,
 * rent breakdown, availability, amenities, photos link, marketing description.
 * Tenant names, ads, and listing actions are portal-internal and deliberately
 * excluded.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";

export function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Bearer-token gate. Returns an error response to send, or null if OK. */
export function requireApiKey(req: Request): NextResponse | null {
  const expected = process.env.INVENTORY_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { error: "INVENTORY_API_KEY is not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  unit_amenities: string[];
  building_amenities: string[];
};

export type RoomRow = {
  id: string;
  room_number: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  available_from: string | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  marketing_description: string | null;
  photos_url: string | null;
  has_private_bathroom: boolean;
  has_ac: boolean;
  properties: PropertyRel | PropertyRel[] | null;
};

export const ROOM_SELECT = `id, room_number, base_rent, bundle_fee, total_rent,
  available_from, status, marketing_description, photos_url,
  has_private_bathroom, has_ac,
  properties(id, building_name, street_address, unit_number, neighborhood,
             unit_amenities, building_amenities)`;

/** Same "listable right now" rule the /inventory page uses. */
export function inInventory(
  status: RoomRow["status"],
  availableFrom: string | null,
  today: string,
): boolean {
  return (
    status === "available" ||
    (status === "occupied" && availableFrom !== null && availableFrom >= today)
  );
}

export function serializeRoom(r: RoomRow) {
  const p = one(r.properties);
  return {
    id: r.id,
    unit: p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : null,
    building_name: p?.building_name ?? null,
    street_address: p?.street_address ?? null,
    unit_number: p?.unit_number ?? null,
    neighborhood: p?.neighborhood ?? null,
    room_number: r.room_number?.replace(/^room\s+/i, "") || null,
    status: r.status,
    available_from: r.available_from,
    rent: {
      base: r.base_rent,
      services: r.bundle_fee,
      total: r.total_rent,
    },
    amenities: {
      has_private_bathroom: r.has_private_bathroom,
      has_ac: r.has_ac,
      unit: p?.unit_amenities ?? [],
      building: p?.building_amenities ?? [],
    },
    photos_url: r.photos_url,
    marketing_description: r.marketing_description,
  };
}
