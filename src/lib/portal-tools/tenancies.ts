import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO, addDaysISO } from "@/lib/date";
import { updateRoomsWithNotification } from "@/lib/notifications";
import { updateTenancyRent } from "@/lib/rent-history";
import type { Database } from "@/lib/supabase/types";
import { admin } from "./helpers";

// TODO: room-transfer and reactivate-into-new-room bot tools. The portal's
// primitives (createTenancyForTenant in @/lib/tenancy-create,
// loadTenancyNetBalance in @/lib/rent-data, applyMoveOut in @/lib/move-out)
// are client-agnostic, so wiring tools here is mechanical — deferred because
// these are multi-step money-moving operations best done with the portal
// UI's previews for now.

export async function endTenancy(args: {
  tenancy_id: string;
  move_out_date: string;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.move_out_date))
    throw new Error("move_out_date must be YYYY-MM-DD.");
  const supabase = admin();
  const today = todayISO();
  // move_out_date is the tenant's LAST day (inclusive): the tenancy stays
  // active through that day and the room becomes available the day after.
  const hasMovedOut = args.move_out_date < today;

  const { data: tenancy, error: lookupErr } = await supabase
    .from("tenancies")
    .select("room_id, start_date, move_out_date, status")
    .eq("id", args.tenancy_id)
    .single();
  if (lookupErr || !tenancy) {
    throw new Error(lookupErr?.message ?? "Tenancy not found.");
  }
  if (args.move_out_date < tenancy.start_date) {
    throw new Error("move_out_date cannot be before the tenancy start date.");
  }

  const { error: updateError } = await supabase
    .from("tenancies")
    .update({
      move_out_date: args.move_out_date,
      status: hasMovedOut ? "ended" : "active",
    })
    .eq("id", args.tenancy_id);
  if (updateError) throw new Error(updateError.message);

  if (tenancy.room_id) {
    // Re-entering the vacancy queue — reset the VA workflow flag to "no action"
    // so the room doesn't inherit the previous tenancy's color.
    const { error: roomError } = await updateRoomsWithNotification(
      supabase,
      tenancy.room_id,
      {
      status: hasMovedOut ? "available" : "occupied",
      available_from: addDaysISO(args.move_out_date, 1),
      listing_action: "no_action",
      },
    );
    if (roomError) {
      await supabase
        .from("tenancies")
        .update({
          move_out_date: tenancy.move_out_date,
          status: tenancy.status,
        })
        .eq("id", args.tenancy_id);
      throw new Error(roomError.message);
    }
  }

  return {
    ok: true,
    tenancy_status: hasMovedOut ? "ended" : "active",
    room_status: hasMovedOut ? "available" : "occupied",
    room_available_from: addDaysISO(args.move_out_date, 1),
    listing_action_reset: true,
  };
}

// Undo a scheduled (or accidental) move-out: tenancy back to active with no
// move-out date, room back to plain occupied. Mirrors reactivateTenancy().
export async function cancelMoveOut(args: { tenancy_id: string }) {
  const supabase = admin();
  const { data: tenancy, error } = await supabase
    .from("tenancies")
    .select("room_id, move_out_date")
    .eq("id", args.tenancy_id)
    .single();
  if (error || !tenancy) throw new Error(error?.message ?? "Tenancy not found.");
  if (!tenancy.move_out_date) {
    return { ok: true, note: "No move-out was scheduled on this tenancy." };
  }

  await supabase
    .from("tenancies")
    .update({ move_out_date: null, status: "active" })
    .eq("id", args.tenancy_id);

  if (tenancy.room_id) {
    await updateRoomsWithNotification(supabase, tenancy.room_id, {
      status: "occupied",
      available_from: null,
    });
  }
  return { ok: true, cancelled_move_out: tenancy.move_out_date };
}

// Patch tenancy money/date fields. A monthly_rent change is a lease renewal:
// it requires new_lease_start + lease_end_date and is recorded in
// tenancy_rent_history effective the lease-start month — which may be in the
// past for a renewal recorded late. Months before the lease start keep
// billing the rate that was in effect back then (first_month_rent only
// affects the calendar month the tenancy starts in).
export async function updateTenancy(args: {
  tenancy_id: string;
  monthly_rent?: number;
  new_lease_start?: string;
  first_month_rent?: number | null;
  security_deposit?: number | null;
  start_date?: string;
  lease_end_date?: string | null;
}) {
  const patch: Database["public"]["Tables"]["tenancies"]["Update"] = {};
  if (args.monthly_rent !== undefined) {
    if (!(args.monthly_rent > 0))
      throw new Error("monthly_rent must be greater than 0.");
    const isDate = (s: unknown): s is string =>
      typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDate(args.new_lease_start) || !isDate(args.lease_end_date))
      throw new Error(
        "Changing monthly_rent is a lease renewal: provide new_lease_start and lease_end_date (YYYY-MM-DD). The new rent takes effect from the lease-start month.",
      );
    if (args.lease_end_date <= args.new_lease_start)
      throw new Error("lease_end_date must be after new_lease_start.");
    patch.monthly_rent = args.monthly_rent;
    // The renewal's start replaces the displayed lease start (NOT start_date,
    // the move-in that anchors ledger accrual).
    patch.lease_start_date = args.new_lease_start;
  } else if (args.new_lease_start !== undefined) {
    throw new Error("new_lease_start only applies when changing monthly_rent.");
  }
  if (args.first_month_rent !== undefined) {
    if (args.first_month_rent !== null && !(args.first_month_rent >= 0))
      throw new Error("first_month_rent must be a non-negative number or null.");
    patch.first_month_rent = args.first_month_rent;
  }
  if (args.security_deposit !== undefined) {
    if (args.security_deposit !== null && !(args.security_deposit >= 0))
      throw new Error("security_deposit must be a non-negative number or null.");
    patch.security_deposit = args.security_deposit;
  }
  if (args.start_date !== undefined) {
    if (!args.start_date) throw new Error("start_date cannot be blank.");
    patch.start_date = args.start_date;
  }
  if (args.lease_end_date !== undefined) {
    patch.lease_end_date = args.lease_end_date;
    // Changing the lease end re-arms the lease-ending reminder crons.
    patch.lease_end_reminded_at = null;
    patch.lease_end_reminded_30_at = null;
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

  const supabase = admin();
  const updatedFields = Object.keys(patch);
  if (args.monthly_rent !== undefined) {
    const { error: rentError } = await updateTenancyRent(
      supabase,
      args.tenancy_id,
      args.monthly_rent,
      args.new_lease_start!,
      args.new_lease_start!,
      args.lease_end_date!,
    );
    if (rentError) throw new Error(rentError);
    delete patch.monthly_rent;
    delete patch.lease_start_date;
    delete patch.lease_end_date;
    delete patch.lease_end_reminded_at;
    delete patch.lease_end_reminded_30_at;
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("tenancies")
      .update(patch)
      .eq("id", args.tenancy_id);
    if (error) throw new Error(error.message);
  }
  return { ok: true, updated_fields: updatedFields };
}

export const tenanciesTools = [
  betaZodTool({
    name: "update_tenancy",
    description:
      "Update a tenancy's rent amounts and lease dates: monthly_rent, " +
      "first_month_rent (prorated amount charged only for the calendar month " +
      "the tenancy starts in; null = full monthly rent), security_deposit " +
      "(informational), start_date, lease_end_date. Changing monthly_rent is " +
      "a lease renewal and REQUIRES new_lease_start and lease_end_date: the " +
      "new rent takes effect from the lease-start month (a past start is " +
      "allowed for a renewal recorded late and reprices those months); " +
      "months before the lease start are untouched. Use " +
      "end_tenancy / cancel_move_out for move-outs.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      monthly_rent: z.number().positive().optional(),
      new_lease_start: z
        .string()
        .optional()
        .describe(
          '"YYYY-MM-DD"; required with monthly_rent — the renewed lease\'s start; the new rent bills from this month',
        ),
      first_month_rent: z.number().min(0).nullable().optional(),
      security_deposit: z.number().min(0).nullable().optional(),
      start_date: z.string().optional().describe('"YYYY-MM-DD"'),
      lease_end_date: z
        .string()
        .nullable()
        .optional()
        .describe(
          '"YYYY-MM-DD"; changing it re-arms lease-ending reminders; required with monthly_rent as the renewed lease\'s end',
        ),
    }),
    run: async (args) => JSON.stringify(await updateTenancy(args)),
  }),
  betaZodTool({
    name: "end_tenancy",
    description:
      "Set a tenancy's move_out_date — the tenant's LAST day in the room, inclusive. " +
      "The tenancy stays Active through that day and the room becomes available the " +
      "NEXT day (rooms.available_from = move_out_date + 1, shown on Inventory as " +
      "'Available from X'). So 'room available from 9/1' means move_out_date 8/31. " +
      "A move_out_date before today ends the tenancy immediately; today/future keeps " +
      "it Active until the day after, when the daily cron finalizes it.",
    inputSchema: z.object({
      tenancy_id: z.string(),
      move_out_date: z
        .string()
        .describe('"YYYY-MM-DD" — the tenant\'s last day, inclusive'),
    }),
    run: async (args) => JSON.stringify(await endTenancy(args)),
  }),
  betaZodTool({
    name: "cancel_move_out",
    description:
      "Cancel a scheduled move-out: clears the tenancy's move_out_date, sets " +
      "it back to active, and returns the room to plain Occupied (no " +
      "available-from date on Inventory). The undo of end_tenancy.",
    inputSchema: z.object({ tenancy_id: z.string() }),
    run: async (args) => JSON.stringify(await cancelMoveOut(args)),
  }),
];
