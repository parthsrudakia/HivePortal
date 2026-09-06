/**
 * Automatic monthly late fees.
 *
 * Policy (from August 2026 on): a tenant still owing more than $200 on
 * their running ledger balance after the end of the 6th gets one $50 late
 * fee for the month. New York units are exempt, as are tenants in their
 * move-in month and utilities-only balances — a balance similar (within
 * UTILITY_ONLY_TOLERANCE) to the utility charges posted this month and/or
 * last month means rent is paid and only a utility share is pending.
 * Runs from the daily ops cron — the date gate below makes it fire on the
 * first invocation on/after the 7th (Eastern), and a rent_reminder_batches
 * row (kind 'late_fee') marks the month done so it never runs twice. A
 * tenancy that already carries a late-fee charge that month — manual or
 * automatic — is skipped, so operators hand-charging first never causes a
 * double fee.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars, fetchTenantLedgers, tenantLedger } from "@/lib/rent-data";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";

/** First month the automatic fee applies ("from August on"). */
const START_PERIOD = "2026-08";

/** Balance must be clear by the end of this day of the month. */
const GRACE_DAY = 6;

const LATE_FEE_AMOUNT = 50;

/** The fee applies only when MORE than this is owed. */
const MIN_OWED = 200;

/** How close ($) a balance must be to the recent utility charges to count
    as "just utilities pending". Similar, not exact — credits and rounding
    leave small residues; rent shortfalls are hundreds of dollars, so a
    modest window can't mask actual unpaid rent. */
const UTILITY_ONLY_TOLERANCE = 10;

export type LateFeeResult = {
  ran: boolean;
  reason?: string;
  period?: string;
  charged?: number;
  skippedExistingFee?: number;
  skippedUtilityOnly?: number;
  tenants?: string[];
  error?: string;
};

export async function applyMonthlyLateFees(
  supabase: SupabaseClient<Database>,
  today: string = todayISO(),
): Promise<LateFeeResult> {
  const period = today.slice(0, 7);
  const day = Number(today.slice(8, 10));

  if (period < START_PERIOD) {
    return { ran: false, reason: `starts ${START_PERIOD}` };
  }
  if (day <= GRACE_DAY) {
    return { ran: false, reason: `waiting for day ${GRACE_DAY + 1}` };
  }

  // Claim the month before calculating or inserting anything. The partial
  // unique index makes concurrent cron invocations race safely: exactly one
  // wins, and a failed winner removes its marker so tomorrow can retry.
  const { data: claimedBatch, error: claimError } = await supabase
    .from("rent_reminder_batches")
    .insert({
      kind: "late_fee",
      period_month: period,
      recipient_count: 0,
      triggered_by: "cron",
    })
    .select("id")
    .single();
  if (claimError) {
    if (claimError.code === "23505") {
      return { ran: false, reason: "already applied this month", period };
    }
    return { ran: false, error: claimError.message, period };
  }

  type PropertyRel = { is_new_york: boolean };
  type RoomRel = { properties: PropertyRel | PropertyRel[] | null };
  type TenancyRow = {
    id: string;
    tenant_id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    paused_at: string | null;
    tenants: { full_name: string } | { full_name: string }[] | null;
    rooms: RoomRel | RoomRel[] | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };
  const { data: tenancies, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
       tenants(full_name),
       rooms(properties(is_new_york)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .returns<TenancyRow[]>();
  if (error) {
    await supabase
      .from("rent_reminder_batches")
      .delete()
      .eq("id", claimedBatch.id);
    return { ran: false, error: error.message, period };
  }

  const [{ charges, allocations, rentChanges }, tl] = await Promise.all([
    fetchLedgerSidecars(supabase),
    fetchTenantLedgers(supabase),
  ]);

  // Tenancies that already have a late fee this month (manual or auto).
  const alreadyFeed = new Set<string>();
  for (const [tenancyId, list] of charges) {
    if (
      list.some(
        (c) =>
          c.kind === "late_fee" &&
          c.charged_on >= `${period}-01` &&
          c.charged_on <= today,
      )
    ) {
      alreadyFeed.add(tenancyId);
    }
  }

  // Previous calendar month ("2026-08" → "2026-07") for the utilities-only check.
  const [pYear, pMonth] = period.split("-").map(Number);
  const prevPeriod =
    pMonth === 1
      ? `${pYear - 1}-12`
      : `${pYear}-${String(pMonth - 1).padStart(2, "0")}`;

  let chargedCount = 0;
  let skippedExistingFee = 0;
  let skippedUtilityOnly = 0;
  const tenants: string[] = [];
  const failures: string[] = [];

  for (const row of tenancies ?? []) {
    // Same eligibility as balance reminders: currently living tenants whose
    // tenancy has started.
    if (row.move_out_date && row.move_out_date <= today) continue;
    if (row.start_date > today) continue;

    // Paused tenancies never receive automatic late fees.
    if (row.paused_at) continue;

    // New York units are exempt from automatic late fees.
    if (one(one(row.rooms)?.properties)?.is_new_york) continue;

    // New tenants get their move-in month fee-free: anyone whose tenancy
    // started on/after the 1st of the current month is skipped this cycle.
    if (row.start_date >= `${period}-01`) continue;

    // Tenant-wide: one ledger per tenant across every room they've had.
    const { netBalance } = tenantLedger(tl, row.tenant_id, () =>
      computeLedger(
        row,
        row.payments ?? [],
        charges.get(row.id) ?? [],
        allocations.get(row.id) ?? [],
        today,
        rentChanges.get(row.id) ?? [],
      ),
    );
    if (netBalance <= MIN_OWED) continue;

    // Utilities-only balances are exempt: when the balance is similar to
    // the utility charges posted this month and/or last month, rent is
    // paid and only a utility share is pending — no fee.
    const utilInMonth = (month: string) =>
      (charges.get(row.id) ?? [])
        .filter(
          (c) =>
            c.kind === "utility_overage" &&
            (c.charged_on ?? "").slice(0, 7) === month,
        )
        .reduce((s, c) => s + Number(c.amount), 0);
    const utilCur = utilInMonth(period);
    const utilPrev = utilInMonth(prevPeriod);
    const utilityOnly = [utilCur, utilPrev, utilCur + utilPrev].some(
      (candidate) =>
        candidate > 0 &&
        Math.abs(netBalance - candidate) <= UTILITY_ONLY_TOLERANCE,
    );
    if (utilityOnly) {
      skippedUtilityOnly++;
      continue;
    }

    if (alreadyFeed.has(row.id)) {
      skippedExistingFee++;
      continue;
    }

    const name = one(row.tenants)?.full_name ?? row.id;
    const { error: insErr } = await supabase.from("tenancy_charges").insert({
      tenancy_id: row.id,
      kind: "late_fee",
      amount: LATE_FEE_AMOUNT,
      charged_on: today,
      dedupe_key: `late_fee:${period}`,
      note: `Auto — balance unpaid after ${period}-0${GRACE_DAY}`,
    });
    if (insErr) {
      if (insErr.code === "23505") {
        skippedExistingFee++;
        continue;
      }
      console.error("[late-fees] charge failed:", insErr.message, name);
      failures.push(name);
      continue;
    }
    chargedCount++;
    tenants.push(name);
  }

  // Finalize the marker only if every insert succeeded. On failure, release
  // the claim; the per-tenancy unique index keeps tomorrow's retry safe.
  if (failures.length === 0) {
    const { error: markerError } = await supabase
      .from("rent_reminder_batches")
      .update({ recipient_count: chargedCount })
      .eq("id", claimedBatch.id);
    if (markerError) {
      return { ran: true, period, charged: chargedCount, error: markerError.message };
    }
  } else {
    await supabase
      .from("rent_reminder_batches")
      .delete()
      .eq("id", claimedBatch.id);
  }

  return {
    ran: true,
    period,
    charged: chargedCount,
    skippedExistingFee,
    skippedUtilityOnly,
    tenants,
    ...(failures.length > 0
      ? { error: `${failures.length} charge(s) failed; will retry tomorrow` }
      : {}),
  };
}
