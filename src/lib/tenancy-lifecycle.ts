import type { SupabaseClient } from "@supabase/supabase-js";
import { todayISO } from "@/lib/date";
import { updateRoomsWithNotification } from "@/lib/notifications";

type LifecycleResult = {
  activated: number;
  ended: number;
  roomsReleased: number;
  error?: string;
};

/**
 * Finalize scheduled move-outs. This is background work, not a render side
 * effect: the daily service-role cron calls it once and reports the outcome.
 *
 * Order matters: expired tenancies are ended BEFORE upcoming ones are
 * activated. `tenancies_one_active_per_room` allows a single active tenancy
 * per room, so on a back-to-back turnover (old tenant out 10/31, new tenant in
 * 11/01) activating the incoming tenancy first collides with the outgoing one
 * still being active — a 409 that used to abort the whole run, leaving every
 * move-out in the portal stuck as active.
 */
export async function processExpiredTenancies(
  supabase: SupabaseClient,
  today: string = todayISO(),
): Promise<LifecycleResult> {
  // 1. End tenancies whose move-out date has passed.
  const { data: expired, error: expiredError } = await supabase
    .from("tenancies")
    .select("id, room_id")
    .eq("status", "active")
    .lt("move_out_date", today)
    .not("move_out_date", "is", null);
  if (expiredError) {
    return { activated: 0, ended: 0, roomsReleased: 0, error: expiredError.message };
  }

  const endedIds = (expired ?? []).map((tenancy) => tenancy.id);
  const endedRoomIds = (expired ?? [])
    .map((tenancy) => tenancy.room_id)
    .filter((id): id is string => Boolean(id));

  if (endedIds.length > 0) {
    const { error: endError } = await supabase
      .from("tenancies")
      .update({ status: "ended" })
      .in("id", endedIds);
    if (endError) {
      return { activated: 0, ended: 0, roomsReleased: 0, error: endError.message };
    }
  }

  // 2. Activate tenancies whose start date has arrived. Their rooms are now
  // free of the outgoing tenancy ended above.
  const { data: starting, error: startingError } = await supabase
    .from("tenancies")
    .select("id, room_id")
    .eq("status", "upcoming")
    .lte("start_date", today);
  if (startingError) {
    return {
      activated: 0,
      ended: endedIds.length,
      roomsReleased: 0,
      error: startingError.message,
    };
  }

  const startingIds = (starting ?? []).map((tenancy) => tenancy.id);
  const startingRoomIds = (starting ?? [])
    .map((tenancy) => tenancy.room_id)
    .filter((id): id is string => Boolean(id));
  if (startingIds.length > 0) {
    const { error: activateError } = await supabase
      .from("tenancies")
      .update({ status: "active" })
      .in("id", startingIds);
    if (activateError) {
      return {
        activated: 0,
        ended: endedIds.length,
        roomsReleased: 0,
        error: activateError.message,
      };
    }
    if (startingRoomIds.length > 0) {
      const { error: occupyError } = await updateRoomsWithNotification(
        supabase,
        startingRoomIds,
        { status: "occupied" },
      );
      if (occupyError) {
        return {
          activated: startingIds.length,
          ended: endedIds.length,
          roomsReleased: 0,
          error: occupyError.message,
        };
      }
    }
  }

  // 3. Release the rooms of ended tenancies. Back-to-back turnover guard: a
  // room may already belong to an incoming tenant (activated just above, or
  // added earlier), so only rooms with no live tenancy left are released.
  let releasableRoomIds: string[] = [];
  if (endedRoomIds.length > 0) {
    const { data: stillHeld, error: heldError } = await supabase
      .from("tenancies")
      .select("room_id")
      .in("room_id", endedRoomIds)
      .in("status", ["active", "upcoming"]);
    if (heldError) {
      return {
        activated: startingIds.length,
        ended: endedIds.length,
        roomsReleased: 0,
        error: heldError.message,
      };
    }
    const held = new Set((stillHeld ?? []).map((t) => t.room_id));
    releasableRoomIds = [...new Set(endedRoomIds)].filter((id) => !held.has(id));
  }

  if (releasableRoomIds.length > 0) {
    const { error: roomError } = await updateRoomsWithNotification(
      supabase,
      releasableRoomIds,
      { status: "available", listing_action: "no_action" },
    );
    if (roomError) {
      return {
        activated: startingIds.length,
        ended: endedIds.length,
        roomsReleased: 0,
        error: roomError.message,
      };
    }
  }

  return {
    activated: startingIds.length,
    ended: endedIds.length,
    roomsReleased: releasableRoomIds.length,
  };
}
