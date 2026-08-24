import type { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type RoomRow = {
  id: string;
  room_number: string | null;
  total_rent: number | null;
  status: "available" | "occupied" | "reserved" | "maintenance";
  available_from: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

export type RoomOption = {
  id: string;
  label: string;
  total_rent: number | null;
};

/**
 * Rooms a tenant can be assigned to: listable on /inventory (available now,
 * or occupied with a future opening), non-archived property, cross-checked
 * against live tenancies — rooms.status is a derived column and has been
 * seen stale (missed write, cached page), which once offered an occupied
 * room to a second tenant. Shared by /tenants/new and the tenant-detail
 * transfer/reactivate dialogs.
 *
 * `includeRoomId` keeps an explicitly-requested room in the list even when
 * it doesn't match the availability rule (the ?room_id= escape hatch).
 */
export async function fetchAssignableRooms(
  supabase: SupabaseServer,
  opts: { includeRoomId?: string } = {},
): Promise<RoomOption[]> {
  const today = todayISO();
  const includeRoomId = opts.includeRoomId ?? "";

  const q = supabase
    .from("rooms")
    .select(
      "id, room_number, total_rent, status, available_from, properties!inner(building_name, street_address, unit_number)",
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})${includeRoomId ? `,id.eq.${includeRoomId}` : ""}`,
    )
    // No new tenants in retired properties.
    .is("properties.archived_at", null)
    .order("available_from", { ascending: true, nullsFirst: true });

  const [{ data }, { data: liveTenancies }] = await Promise.all([
    q.returns<RoomRow[]>(),
    // Occupancy cross-check straight from tenancies (see doc comment).
    supabase
      .from("tenancies")
      .select("room_id, status, move_out_date")
      .in("status", ["active", "upcoming"]),
  ]);

  // A room's slot is taken when an upcoming tenancy has claimed it, or an
  // active tenancy has no future move-out date. (An active tenant moving out
  // soon matches the "opens ..." case above and stays offered.)
  const takenRoomIds = new Set(
    (liveTenancies ?? [])
      .filter(
        (t) =>
          t.status === "upcoming" ||
          !(t.move_out_date && t.move_out_date >= today),
      )
      .map((t) => t.room_id),
  );

  return (data ?? [])
    .filter((r) => r.id === includeRoomId || !takenRoomIds.has(r.id))
    .map((r) => {
      const p = one(r.properties);
      const unitTitle = p
        ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
        : "—";
      const scheduled = r.status === "occupied" && r.available_from;
      const suffix = scheduled ? ` (opens ${r.available_from})` : "";
      return {
        id: r.id,
        label: `${unitTitle} · ${r.room_number ?? "Room"}${suffix}`,
        total_rent: r.total_rent,
      };
    });
}
