import type { createClient } from "@/lib/supabase/server";
import { todayISO, addDaysISO } from "@/lib/date";
import { updateRoomsWithNotification } from "@/lib/notifications";

// Services bundle baked into every room's rent: utilities + wi-fi + maid +
// amenities. A room's total_rent (generated) = base_rent + bundle_fee.
export const BUNDLE_FEE = 125;

// ----- End (or schedule the end of) a tenancy -----
// move_out_date is the tenant's LAST day in the room, inclusive.
// If move_out_date is before today  → tenant has moved out; room is Available now.
// If move_out_date is today/future  → tenant is still there through that day;
//                                    room stays Occupied but we set
//                                    `rooms.available_from = move_out_date + 1` so it
//                                    surfaces on /inventory as "Available from X".
//                                    Tenancy stays 'active' and is auto-finalized
//                                    when move_out_date passes (see processExpiredTenancies).

export async function applyMoveOut(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenancy_id: string,
  move_out_date: string,
) {
  const today = todayISO();
  const hasMovedOut = move_out_date < today;

  const { data: tenancy, error: tenancyLoadError } = await supabase
    .from("tenancies")
    .select("room_id, monthly_rent, start_date, move_out_date, status")
    .eq("id", tenancy_id)
    .single();
  if (tenancyLoadError || !tenancy) {
    return { error: tenancyLoadError?.message ?? "Tenancy not found." };
  }
  if (move_out_date < tenancy.start_date) {
    return { error: "Move-out date cannot be before the tenancy start date." };
  }

  const { error: tenancyUpdateError } = await supabase
    .from("tenancies")
    .update({
      move_out_date,
      status: hasMovedOut ? "ended" : "active",
    })
    .eq("id", tenancy_id);
  if (tenancyUpdateError) return { error: tenancyUpdateError.message };

  if (tenancy?.room_id) {
    // A room with no available_from is entering a NEW vacancy cycle (vs. a
    // date edit on an already-listed opening, which must keep the ads posted
    // for the current window).
    const { data: roomBefore } = await supabase
      .from("rooms")
      .select("available_from")
      .eq("id", tenancy.room_id)
      .maybeSingle();
    const freshListing = !roomBefore?.available_from;

    // Carry the last tenant's rent forward as the room's list price. Their
    // monthly_rent is the all-in total (base + $125 bundle), so split it back
    // into base_rent + the services bundle; the room's generated total_rent
    // then equals exactly what the tenant was paying.
    const total = Number(tenancy.monthly_rent);
    const rentPatch =
      Number.isFinite(total) && total > 0
        ? { base_rent: Math.max(0, total - BUNDLE_FEE), bundle_fee: BUNDLE_FEE }
        : {};

    // Re-entering the vacancy queue — reset the VA workflow flag to "no action"
    // so the room doesn't inherit the previous tenancy's color.
    const { error: roomError } = await updateRoomsWithNotification(
      supabase,
      tenancy.room_id,
      {
      status: hasMovedOut ? "available" : "occupied",
      available_from: addDaysISO(move_out_date, 1),
      listing_action: "no_action",
      ...rentPatch,
      },
    );
    if (roomError) {
      await supabase
        .from("tenancies")
        .update({
          move_out_date: tenancy.move_out_date,
          status: tenancy.status,
        })
        .eq("id", tenancy_id);
      return { error: roomError.message };
    }

    // Fresh listings start with no ads — the previous cycle's ad URLs are
    // stale (old price/date, possibly expired posts). Best-effort: a failed
    // cleanup leaves stale ads behind but never blocks the move-out.
    if (freshListing) {
      await supabase.from("room_ads").delete().eq("room_id", tenancy.room_id);
    }
  }
  return {};
}
