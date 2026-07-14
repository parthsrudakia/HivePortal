/**
 * Automatic monthly late fees.
 *
 * Policy (from August 2026 on): a tenant who hasn't cleared their running
 * ledger balance by the end of the 6th gets one $50 late fee for the month.
 * Runs from the daily ops cron — the date gate below makes it fire on the
 * first invocation on/after the 7th (Eastern), and a rent_reminder_batches
 * row (kind 'late_fee') marks the month done so it never runs twice. A
 * tenancy that already carries a late-fee charge that month — manual or
 * automatic — is skipped, so operators hand-charging first never causes a
 * double fee.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";

/** First month the automatic fee applies ("from August on"). */
const START_PERIOD = "2026-08";

/** Balance must be clear by the end of this day of the month. */
const GRACE_DAY = 6;

const LATE_FEE_AMOUNT = 50;

/** Ignore sub-dollar residue — a $50 fee on pennies helps no one. */
const MIN_OWED = 1;

export type LateFeeResult = {
  ran: boolean;
  reason?: string;
  period?: string;
  charged?: number;
  skippedExistingFee?: number;
  tenants?: string[];
  error?: string;
};

export async function applyMonthlyLateFees(
  supabase: SupabaseClient,
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

  // Run-once-per-month marker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const { data: existingBatch } = await sb
    .from("rent_reminder_batches")
    .select("id")
    .eq("kind", "late_fee")
    .eq("period_month", period)
    .limit(1)
    .maybeSingle();
  if (existingBatch) {
    return { ran: false, reason: "already applied this month", period };
  }

  type TenancyRow = {
    id: string;
    monthly_rent: number;
    first_month_rent: number | null;
    security_deposit: number | null;
    start_date: string;
    move_out_date: string | null;
    tenants: { full_name: string } | { full_name: string }[] | null;
    payments: { amount: number; paid_on: string; payment_type: string }[];
  };
  const { data: tenancies, error } = await supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date,
       tenants(full_name),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .returns<TenancyRow[]>();
  if (error) return { ran: false, error: error.message, period };

  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);

  // Tenancies that already have a late fee this month (manual or auto).
  const alreadyFeed = new Set<string>();
  for (const [tenancyId, list] of charges) {
    if (
      list.some(
        (c) => c.kind === "late_fee" && c.charged_on >= `${period}-01`,
      )
    ) {
      alreadyFeed.add(tenancyId);
    }
  }

  const monthEnd = `${period}-31`;
  let chargedCount = 0;
  let skippedExistingFee = 0;
  const tenants: string[] = [];
  const failures: string[] = [];

  for (const row of tenancies ?? []) {
    // Same eligibility as balance reminders: currently living tenants whose
    // tenancy has started.
    if (row.move_out_date && row.move_out_date <= today) continue;
    if (row.start_date > monthEnd) continue;

    const { netBalance } = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
      rentChanges.get(row.id) ?? [],
    );
    if (netBalance < MIN_OWED) continue;

    if (alreadyFeed.has(row.id)) {
      skippedExistingFee++;
      continue;
    }

    const name = one(row.tenants)?.full_name ?? row.id;
    const { error: insErr } = await sb.from("tenancy_charges").insert({
      tenancy_id: row.id,
      kind: "late_fee",
      amount: LATE_FEE_AMOUNT,
      charged_on: today,
      note: `Auto — balance unpaid after ${period}-0${GRACE_DAY}`,
    });
    if (insErr) {
      console.error("[late-fees] charge failed:", insErr.message, name);
      failures.push(name);
      continue;
    }
    chargedCount++;
    tenants.push(name);
  }

  // Mark the month done only if no insert failed — a failed tenant gets
  // retried on tomorrow's run (the per-tenancy existing-fee check keeps the
  // successful ones from double-charging).
  if (failures.length === 0) {
    await sb.from("rent_reminder_batches").insert({
      kind: "late_fee",
      period_month: period,
      recipient_count: chargedCount,
      triggered_by: "cron",
    });
  }

  return {
    ran: true,
    period,
    charged: chargedCount,
    skippedExistingFee,
    tenants,
    ...(failures.length > 0
      ? { error: `${failures.length} charge(s) failed; will retry tomorrow` }
      : {}),
  };
}
