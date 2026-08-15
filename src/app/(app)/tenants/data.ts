/**
 * Request-cached fetchers shared by the Rent Tracker's streamed sections
 * (KPIs, side lists, tracker table). Each section awaits only what it needs;
 * cache() plus the request-stable client dedupes anything they share, so the
 * page still issues one parallel query wave.
 */

import { cache } from "react";
import { getCachedClient } from "@/lib/supabase/server";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { computeLedger, rateForMonthISO } from "@/lib/rent";
import { todayISO, currentRentCycle } from "@/lib/date";
import { getReminderInfo } from "./reminder-info";

export type TenantRel = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
};
export type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
export type RoomRel = {
  id: string;
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

export type ActiveTenancyRow = {
  id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  tenant_id: string;
  tenants: TenantRel | TenantRel[] | null;
  rooms: RoomRel | RoomRel[] | null;
  payments: {
    id: string;
    amount: number;
    paid_on: string;
    payment_type: string;
  }[];
};

export const getActiveTenancies = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at, tenant_id,
       tenants(id, full_name, email, phone),
       rooms(id, room_number,
             properties(id, building_name, street_address, unit_number)),
       payments(id, amount, paid_on, payment_type)`,
    )
    .eq("status", "active")
    .order("start_date", { ascending: false })
    .returns<ActiveTenancyRow[]>();
});

// The full CURRENT portfolio — vacant properties still get a (empty) group.
// Retired (archived) properties stay off the tracker; their active tenancies,
// if any remain, still show via getActiveTenancies until the move-out passes.
export const getAllProperties = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number")
    .is("archived_at", null);
});

// Ended tenancies — their outstanding balances feed the "Moved out with
// balance" section so departed debt stays visible until dismissed.
export const getEndedTenancies = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("tenancies")
    .select(
      `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at,
       balance_dismissed_at,
       tenants(id, full_name),
       rooms(room_number,
             properties(building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "ended")
    .order("move_out_date", { ascending: false });
});

// Future-dated tenancies — invisible to the active groups until the daily
// cron activates them, so they get their own "Upcoming move-ins" section.
export const getUpcomingTenancies = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("tenancies")
    .select(
      `id, start_date, monthly_rent,
       tenants(id, full_name),
       rooms(room_number,
             properties(building_name, street_address, unit_number))`,
    )
    .eq("status", "upcoming")
    .order("start_date", { ascending: true });
});

// Utility-overage shares that hit already-moved-out tenants (admin-only UI).
export const getOverageAlerts = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("utility_overage_alerts")
    .select("id, tenant_name, unit_label, amount, period_label")
    .is("acknowledged_at", null)
    .order("created_at", { ascending: true });
});

// Ad-hoc charges + credit allocations feed the running ledger balance.
export const getSidecars = cache(async () =>
  fetchLedgerSidecars(await getCachedClient()),
);

// Balance-reminder button state, reusing the already-loaded roster instead of
// re-fetching tenancies+payments (previously the page's duplicate query).
export const getTenantsReminderInfo = cache(async () => {
  const supabase = await getCachedClient();
  const { data } = await getActiveTenancies();
  return getReminderInfo(supabase, data ?? []);
});

/**
 * What's owed for a single tenancy in the given rent cycle.
 *  • Tenancy starts after this month → 0 (shouldn't happen here since we
 *    only fetch active tenancies, but defensive).
 *  • Starting month AND tenancy has first_month_rent set → use that.
 *  • Otherwise → monthly_rent (full month).
 */
function dueForMonth(
  startDate: string,
  monthlyRent: number,
  firstMonthRent: number | null,
  monthStart: string,
  monthEnd: string,
  today: string,
): number {
  if (startDate > monthEnd || startDate > today) return 0;
  const isStartingMonth = startDate >= monthStart && startDate <= monthEnd;
  if (isStartingMonth && firstMonthRent !== null) {
    return firstMonthRent;
  }
  return monthlyRent;
}

export type RowWithStatus = ActiveTenancyRow & {
  paidThisMonth: number;
  /** This cycle's rent-typed payments minus this cycle's security_deposit
      charges. Zelle can't tell rent from deposit money — recon posts every
      matched credit with payment_type 'rent' — but the operator marks a
      deposit's arrival by applying a security_deposit charge, so deducting
      those charges leaves actual rent for the Collected KPIs. */
  rentPaidThisMonth: number;
  /** Deposit money received this cycle: security_deposit charges applied
      (the marker for Zelle-collected deposits) plus explicitly-typed
      security_deposit payments. */
  depositCollectedThisMonth: number;
  balance: number;
  due: number;
};

// Per row we keep the *this-month* operational figures (Due / Paid, mirrored
// by the portfolio KPIs and progress bar) but Balance is the running net
// ledger balance, which carries arrears/credit across months. Shared by the
// KPI section and the tracker table.
export const getRowsWithStatus = cache(async () => {
  const [{ data, error }, { charges, allocations, rentChanges }] =
    await Promise.all([getActiveTenancies(), getSidecars()]);
  const today = todayISO();
  // Rent is collected on a 27th→26th cycle (tenants pay from the 27th), so
  // "this month" runs from the 27th of the prior month to the 26th.
  const { start: monthStart, end: monthEnd } = currentRentCycle();

  const rows: RowWithStatus[] = (data ?? []).map((row) => {
    const paidThisMonth = (row.payments ?? [])
      .filter(
        (p) =>
          (p.payment_type === "rent" || p.payment_type === "refund") &&
          p.paid_on >= monthStart &&
          p.paid_on <= monthEnd &&
          p.paid_on <= today,
      )
      .reduce(
        (sum, p) =>
          sum + (p.payment_type === "refund" ? -1 : 1) * Number(p.amount),
        0,
      );
    const effectiveRate = rateForMonthISO(
      monthEnd,
      row.monthly_rent,
      rentChanges.get(row.id) ?? [],
    );
    const due = dueForMonth(
      row.start_date,
      effectiveRate,
      row.first_month_rent !== null ? Number(row.first_month_rent) : null,
      monthStart,
      monthEnd,
      today,
    );
    const ledger = computeLedger(
      row,
      row.payments ?? [],
      charges.get(row.id) ?? [],
      allocations.get(row.id) ?? [],
      today,
      rentChanges.get(row.id) ?? [],
    );
    const inCycle = (d: string | null | undefined) =>
      !!d && d >= monthStart && d <= monthEnd && d <= today;
    const depositChargedThisMonth = (charges.get(row.id) ?? [])
      .filter((c) => c.kind === "security_deposit" && inCycle(c.charged_on))
      .reduce((s, c) => s + Number(c.amount), 0);
    const depositPaidThisMonth = (row.payments ?? [])
      .filter((p) => p.payment_type === "security_deposit" && inCycle(p.paid_on))
      .reduce((s, p) => s + Number(p.amount), 0);
    return {
      ...row,
      paidThisMonth,
      rentPaidThisMonth: Math.max(0, paidThisMonth - depositChargedThisMonth),
      depositCollectedThisMonth: depositChargedThisMonth + depositPaidThisMonth,
      balance: ledger.netBalance,
      due,
    };
  });

  return { rows, error };
});
