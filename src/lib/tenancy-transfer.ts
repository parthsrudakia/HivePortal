import type { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { addDaysISO, proratedDaysStayed, proratedMonthRemainder, todayISO } from "@/lib/date";
import { rateForMonthISO } from "@/lib/rent";
import { applyMoveOut } from "@/lib/move-out";
import { createTenancyForTenant } from "@/lib/tenancy-create";
import { loadTenancyNetBalance } from "@/lib/rent-data";
import { updateRoomsWithNotification } from "@/lib/notifications";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

// ----- Transfer an active tenant to a different room -----
// Ends the current tenancy on the transfer date (the tenant's last day in
// the old room) and starts a new tenancy in the destination. The old room's
// move-out month bills only the days stayed (last_month_rent =
// monthly rent / days in month × days stayed); the new room's first month is
// prorated from the move-in day. The old ledger's net position is carried
// across as a settlement/adjustment pair so the tenant owes (or is owed) the
// same total, just in one place.
//
// Shared by the portal's Transfer dialog and the agreement send path (an
// agreement sent to an existing tenant for a different room is a transfer).

export type TransferInput = {
  tenancy_id: string;
  tenant_id: string;
  dest_room_id: string;
  /** Tenant's last day in the old room (inclusive). */
  transfer_date: string;
  /** First day in the new room; defaults to the day after transfer_date. */
  new_start_date?: string | null;
  new_monthly_rent: number;
  /** Null = prorate a mid-month start automatically. */
  first_month_rent?: number | null;
  /** Null = the deposit stays what it was in the old room. */
  new_security_deposit?: number | null;
  lease_end_date?: string | null;
  /**
   * Allow transferring a tenancy that already has a move-out booked — the
   * booked date is replaced by transfer_date. The portal dialog leaves this
   * off (it asks the operator to clear the move-out first); the agreement
   * path turns it on because the new agreement defines the move-out.
   */
  replaceScheduledMoveOut?: boolean;
};

export type TransferResult =
  | { error: string }
  | {
      error?: undefined;
      newTenancyId: string;
      /** Prorated rent billed for the old room's move-out month. */
      lastMonthRent: number;
      warning?: string;
    };

type TransferRoomRel = {
  room_number: string | null;
  properties:
    | { building_name: string | null; street_address: string; unit_number: string }
    | { building_name: string | null; street_address: string; unit_number: string }[]
    | null;
};

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function transferRoomLabel(room: TransferRoomRel | null): string {
  if (!room) return "previous room";
  const p = one(room.properties);
  const unit = p
    ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
    : "—";
  return `${unit} · ${room.room_number ?? "Room"}`;
}

export async function transferTenant(
  supabase: SupabaseServer,
  input: TransferInput,
): Promise<TransferResult> {
  const { tenancy_id, tenant_id, dest_room_id, transfer_date } = input;
  const new_start_date = input.new_start_date || addDaysISO(transfer_date, 1);
  if (new_start_date <= transfer_date)
    return { error: "The new room's start date must be after the transfer date." };

  // The active requirement doubles as the double-submit guard: a second
  // submit finds the old tenancy already ended (or, from the dialog, already
  // ending) and aborts.
  const { data: old } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, room_id, start_date, status, move_out_date, security_deposit, monthly_rent,
       rooms(room_number, properties(building_name, street_address, unit_number))`,
    )
    .eq("id", tenancy_id)
    .maybeSingle();
  if (!old || old.tenant_id !== tenant_id) return { error: "Tenancy not found." };
  if (old.status !== "active")
    return { error: "Only an active tenancy can be transferred." };
  if (old.move_out_date && !input.replaceScheduledMoveOut)
    return {
      error:
        "Only an active tenancy without a scheduled move-out can be transferred.",
    };
  if (old.room_id === dest_room_id)
    return {
      error: "That's the tenant's current room — edit the rent in place instead.",
    };
  if (transfer_date < old.start_date)
    return { error: "Transfer date cannot be before the tenancy start date." };

  const { data: destRoom } = await supabase
    .from("rooms")
    .select("room_number, properties(building_name, street_address, unit_number)")
    .eq("id", dest_room_id)
    .maybeSingle();
  if (!destRoom) return { error: "Destination room not found." };

  // Old room's last month: only the days stayed, at the rate in effect that
  // month (rent-history aware, like the ledger).
  const { data: history, error: historyErr } = await supabase
    .from("tenancy_rent_history")
    .select("effective_month, monthly_rent")
    .eq("tenancy_id", tenancy_id);
  if (historyErr) return { error: historyErr.message };
  const lastMonthRate = rateForMonthISO(
    transfer_date,
    old.monthly_rent,
    history ?? [],
  );
  const lastMonthRent = proratedDaysStayed(
    old.start_date,
    transfer_date,
    lastMonthRate,
  );

  // The deposit already held carries over physically, so the new room never
  // re-charges it in full: only the DIFFERENCE between the old and new deposit
  // posts (a top-up charge when it goes up, a credit when it goes down).
  const old_deposit = Number(old.security_deposit ?? 0);
  const dest_deposit = input.new_security_deposit ?? old_deposit;
  const deposit_delta = Math.round((dest_deposit - old_deposit) * 100) / 100;

  // 1) Create the new tenancy first: the worst partial state is a visible,
  //    deletable upcoming tenancy — never a tenant with no tenancy.
  const first_month_rent = input.first_month_rent ?? null;
  const created = await createTenancyForTenant(supabase, {
    tenant_id,
    room_id: dest_room_id,
    start_date: new_start_date,
    monthly_rent: input.new_monthly_rent,
    first_month_rent:
      first_month_rent === null && !new_start_date.endsWith("-01")
        ? proratedMonthRemainder(new_start_date, input.new_monthly_rent)
        : first_month_rent,
    security_deposit: dest_deposit,
    lease_end_date: input.lease_end_date ?? null,
    postDepositCharge: false,
  });
  if ("error" in created) return { error: created.error };

  // 2) End the old tenancy (room release, available_from, cleaning record).
  const ended = await applyMoveOut(supabase, tenancy_id, transfer_date);
  if (ended.error) {
    await supabase.from("tenancy_charges").delete().eq("tenancy_id", created.tenancy_id);
    await supabase.from("tenancies").delete().eq("id", created.tenancy_id);
    if (created.prior_room) {
      await updateRoomsWithNotification(supabase, dest_room_id, {
        status: created.prior_room.status,
        pending_tenant: created.prior_room.pending_tenant,
        available_from: created.prior_room.available_from,
      });
    }
    return { error: ended.error };
  }

  // 3) Prorate the old room's move-out month. Before the carry, so the
  //    carried balance reflects only the days actually stayed.
  const warnings: string[] = [];
  const { error: lastErr } = await supabase
    .from("tenancies")
    .update({ last_month_rent: lastMonthRent })
    .eq("id", tenancy_id);
  if (lastErr)
    warnings.push(
      `the old room's last month could not be prorated to ${fmtUsd(lastMonthRent)} (${lastErr.message}) — set it on the ledger manually`,
    );

  // 4) Carry the ledger position. Computed after the move-out so rent stops
  //    accruing at the transfer month; asOf covers scheduled transfers.
  const today = todayISO();
  const asOf = transfer_date > today ? transfer_date : today;
  const ledger = await loadTenancyNetBalance(supabase, tenancy_id, asOf);
  const netBalance = ledger?.netBalance ?? 0;
  let carryOk = true;
  if (Math.abs(netBalance) > 0.005) {
    // A debt leaves the old room as a 'settlement' (write-off, not money
    // received). A CREDIT can't: the tenancy_charges check only allows a
    // negative amount on an 'adjustment', and a negative adjustment is the
    // designed debit line that absorbs credit — so the credit case posts
    // that instead. The receiving side is an adjustment either way.
    const { data: settlement, error: settleErr } = await supabase
      .from("tenancy_charges")
      .insert({
        tenancy_id,
        kind: netBalance > 0 ? "settlement" : "adjustment",
        amount: netBalance,
        charged_on: transfer_date,
        note: `Balance carried to ${transferRoomLabel(destRoom)}`,
      })
      .select("id")
      .single();
    if (settleErr) {
      carryOk = false;
      warnings.push(
        `the balance carry failed (${settleErr.message}) — post a settlement on the old ledger and a matching adjustment on the new one manually`,
      );
    } else {
      const { error: adjErr } = await supabase.from("tenancy_charges").insert({
        tenancy_id: created.tenancy_id,
        kind: "adjustment",
        amount: -netBalance,
        charged_on: new_start_date,
        note: `Balance carried from ${transferRoomLabel(one(old.rooms))}`,
      });
      if (adjErr) {
        // Never leave a half-carry: without the offsetting adjustment the
        // settlement would silently erase the debt.
        if (settlement)
          await supabase.from("tenancy_charges").delete().eq("id", settlement.id);
        carryOk = false;
        warnings.push(
          `the balance carry failed (${adjErr.message}) — post a settlement on the old ledger and a matching adjustment on the new one manually`,
        );
      }
    }
  }

  // 5) Deposit difference on the NEW ledger, as a 'security_deposit' charge
  //    either way so the tenant-wide deposit bucket always sums to the deposit
  //    actually held. Posted after the carry so the carried balance reflects
  //    only the old room.
  if (carryOk && Math.abs(deposit_delta) > 0.005) {
    const oldLabel = transferRoomLabel(one(old.rooms));
    const { error: depositErr } = await supabase.from("tenancy_charges").insert({
      tenancy_id: created.tenancy_id,
      kind: "security_deposit",
      amount: deposit_delta,
      charged_on: new_start_date,
      note:
        deposit_delta > 0
          ? `Deposit increase to ${fmtUsd(dest_deposit)} — ${fmtUsd(old_deposit)} carried from ${oldLabel}`
          : `Deposit reduced to ${fmtUsd(dest_deposit)} — ${fmtUsd(old_deposit)} carried from ${oldLabel}`,
    });
    if (depositErr)
      warnings.push(
        `the deposit difference of ${fmtUsd(Math.abs(deposit_delta))} did not post (${depositErr.message}) — post it on the new ledger manually`,
      );
  } else if (Math.abs(deposit_delta) > 0.005) {
    warnings.push(
      `the deposit difference of ${fmtUsd(Math.abs(deposit_delta))} was not posted — post it on the new ledger after fixing the carry`,
    );
  }

  return {
    newTenancyId: created.tenancy_id,
    lastMonthRent,
    warning: warnings.length
      ? `Transferred, but ${warnings.join("; and ")}.`
      : undefined,
  };
}
