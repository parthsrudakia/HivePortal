/**
 * GET /api/inventory/[roomId] — one currently-listed room's core listing data.
 * Requires `Authorization: Bearer $INVENTORY_API_KEY`.
 *
 * 404s both when the room id doesn't exist and when the room exists but isn't
 * in inventory right now (filled, reserved/maintenance, or pending a tenant) —
 * this endpoint only serves what /api/inventory lists.
 */

import { NextResponse, type NextRequest } from "next/server";
import { todayISO } from "@/lib/date";
import {
  admin,
  requireApiKey,
  serializeRoom,
  inInventory,
  ROOM_SELECT,
  type RoomRow,
} from "../shared";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const { roomId } = await params;

  const supabase = admin();
  const { data, error } = await supabase
    .from("rooms")
    .select(`${ROOM_SELECT}, pending_tenant`)
    .eq("id", roomId)
    .maybeSingle<RoomRow & { pending_tenant: boolean }>();

  if (error) {
    // 22P02: roomId isn't a valid uuid — treat as not-found, not a server error.
    if (error.code === "22P02") {
      return NextResponse.json({ error: "room not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  const today = todayISO();
  if (data.pending_tenant || !inInventory(data.status, data.available_from, today)) {
    return NextResponse.json(
      { error: "room is not currently in inventory" },
      { status: 404 },
    );
  }

  return NextResponse.json({ as_of: today, room: serializeRoom(data) });
}
