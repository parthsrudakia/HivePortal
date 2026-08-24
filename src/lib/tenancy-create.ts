import type { createClient } from "@/lib/supabase/server";
import { todayISO } from "@/lib/date";
import { one } from "@/lib/relations";
import { updateRoomsWithNotification } from "@/lib/notifications";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

// ----- Room double-booking guard -----
// Same slot rule as the /tenants/new picker: an upcoming tenancy claims the
// room outright; an active one blocks unless its move-out precedes the new
// start date. Runs before anything is created so a clash needs no cleanup.

export async function findRoomClash(
  supabase: SupabaseServer,
  room_id: string,
  start_date: string,
): Promise<{ error: string } | null> {
  const { data: occupants, error: occErr } = await supabase
    .from("tenancies")
    .select("status, move_out_date, tenants(full_name)")
    .eq("room_id", room_id)
    .in("status", ["active", "upcoming"]);
  if (occErr) return { error: occErr.message };
  const clash = (occupants ?? []).find(
    (t) =>
      t.status === "upcoming" ||
      !t.move_out_date ||
      t.move_out_date >= start_date,
  );
  if (!clash) return null;
  const who = one(clash.tenants)?.full_name ?? "another tenant";
  return {
    error:
      clash.status === "upcoming"
        ? `That room is already reserved for ${who} (upcoming move-in). Pick another room.`
        : `That room is occupied by ${who}${clash.move_out_date ? ` through ${clash.move_out_date}` : ""}. Pick another room.`,
  };
}

// ----- Create a tenancy for an EXISTING tenant -----
// The tenant+tenancy pair in createTenant stays as-is (it interleaves the
// lease-PDF upload); this primitive covers the flows that add a tenancy to a
// tenant who already exists: reactivating a past tenant into a new room and
// transferring an active tenant between rooms.

export type NewTenancyInput = {
  tenant_id: string;
  room_id: string;
  /** Billing/occupancy start (ledger accrual anchor). */
  start_date: string;
  monthly_rent: number;
  first_month_rent?: number | null;
  security_deposit?: number | null;
  lease_end_date?: string | null;
  /**
   * Post the matching security-deposit ledger charge dated at start. Skip for
   * transfers, where the deposit physically carries over from the old room
   * and charging again would double-bill it.
   */
  postDepositCharge?: boolean;
};

export type PriorRoomState = {
  status: "occupied" | "available" | "reserved" | "maintenance";
  pending_tenant: boolean;
  available_from: string | null;
} | null;

export async function createTenancyForTenant(
  supabase: SupabaseServer,
  input: NewTenancyInput,
): Promise<
  | { tenancy_id: string; prior_room: PriorRoomState }
  | { error: string; tenancy_id?: undefined }
> {
  const clash = await findRoomClash(supabase, input.room_id, input.start_date);
  if (clash) return clash;

  // Captured before the patch so a caller composing multiple steps (transfer)
  // can restore the room if a later step fails.
  const { data: room } = await supabase
    .from("rooms")
    .select("status, pending_tenant, available_from")
    .eq("id", input.room_id)
    .maybeSingle();

  const future = input.start_date > todayISO();
  const { data: tenancy, error: insertError } = await supabase
    .from("tenancies")
    .insert({
      room_id: input.room_id,
      tenant_id: input.tenant_id,
      start_date: input.start_date,
      lease_end_date: input.lease_end_date ?? null,
      monthly_rent: input.monthly_rent,
      first_month_rent: input.first_month_rent ?? null,
      security_deposit: input.security_deposit ?? null,
      status: future ? "upcoming" : "active",
    })
    .select("id")
    .single();
  if (insertError || !tenancy) {
    return { error: insertError?.message ?? "Failed to create the tenancy." };
  }

  const deposit = input.security_deposit ?? null;
  if (input.postDepositCharge && deposit !== null && deposit > 0) {
    const { error: depositError } = await supabase
      .from("tenancy_charges")
      .insert({
        tenancy_id: tenancy.id,
        kind: "security_deposit",
        amount: deposit,
        charged_on: input.start_date,
        note: "Security deposit due at move-in",
      });
    if (depositError) {
      await supabase.from("tenancies").delete().eq("id", tenancy.id);
      return {
        error: `Failed to post the security-deposit charge: ${depositError.message}`,
      };
    }
  }

  // Future tenancies reserve the room but do not become billable/active
  // until the lifecycle cron reaches their start date.
  const { error: roomError } = await updateRoomsWithNotification(
    supabase,
    input.room_id,
    {
      status: future ? "reserved" : "occupied",
      pending_tenant: false,
    },
  );
  if (roomError) {
    // tenancy_charges FK is on delete restrict — charges go first.
    await supabase
      .from("tenancy_charges")
      .delete()
      .eq("tenancy_id", tenancy.id);
    await supabase.from("tenancies").delete().eq("id", tenancy.id);
    return { error: roomError.message };
  }

  return {
    tenancy_id: tenancy.id,
    prior_room: room
      ? {
          status: room.status,
          pending_tenant: room.pending_tenant ?? false,
          available_from: room.available_from,
        }
      : null,
  };
}
