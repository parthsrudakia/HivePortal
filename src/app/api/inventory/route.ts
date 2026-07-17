/**
 * GET /api/inventory — read-only list of every room currently in inventory
 * (available now, or occupied with a scheduled move-out), for internal
 * tools/scripts. Requires `Authorization: Bearer $INVENTORY_API_KEY`.
 *
 * Optional query params mirror the portal table's sorting:
 *   ?sort=unit|neighborhood|available|rent|services|total  (default: available)
 *   ?dir=asc|desc                                           (default: asc)
 */

import { NextResponse, type NextRequest } from "next/server";
import { todayISO } from "@/lib/date";
import {
  parseInventoryParams,
  filterAndSortRooms,
} from "@/lib/inventory-filter";
import {
  admin,
  requireApiKey,
  serializeRoom,
  ROOM_SELECT,
  type RoomRow,
} from "./shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const { sort, dir } = parseInventoryParams(req.nextUrl.searchParams);

  const supabase = admin();
  const today = todayISO();
  const { data, error } = await supabase
    .from("rooms")
    .select(ROOM_SELECT)
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .returns<RoomRow[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The shared sorter expects each room to carry its ads (for the poster
  // filter, which this API doesn't expose) — pass empty lists.
  const sorted = filterAndSortRooms(
    (data ?? []).map((r) => ({ ...r, ads: [] })),
    { sort, dir, posterKeys: null },
  );

  return NextResponse.json({
    as_of: today,
    count: sorted.length,
    rooms: sorted.map(serializeRoom),
  });
}
