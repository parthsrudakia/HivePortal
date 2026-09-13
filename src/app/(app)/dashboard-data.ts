/**
 * Request-cached fetchers/derivations shared by the dashboard's streamed
 * sections. Sibling sections render concurrently, so these all fire in one
 * parallel wave; cache() plus the request-stable client dedupes the overlap
 * (tenancies + payments + sidecars feed both the KPIs and the rent worklist).
 */

import { cache } from "react";
import { getCachedClient } from "@/lib/supabase/server";
import {
  LedgerDataError,
  fetchLedgerSidecars,
  fetchTenantLedgers,
  tenantLedger,
} from "@/lib/rent-data";
import { computeLedger } from "@/lib/rent";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/cleaning";
import { currentRentCycle } from "@/lib/date";

export type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};

export function unitLabel(p: PropertyRel | null | undefined) {
  if (!p) return "—";
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

export type TenancyRow = {
  id: string;
  tenant_id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  lease_end_date: string | null;
  rooms:
    | {
        room_number: string | null;
        properties: PropertyRel | PropertyRel[] | null;
      }
    | {
        room_number: string | null;
        properties: PropertyRel | PropertyRel[] | null;
      }[]
    | null;
  tenants:
    | { full_name: string; email: string | null; phone: string | null }
    | { full_name: string; email: string | null; phone: string | null }[]
    | null;
};

export const getPropertyCount = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("properties")
    .select("*", { count: "exact", head: true })
    .is("archived_at", null);
});

export const getRoomCount = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("rooms")
    .select("id, properties!inner(id)", { count: "exact", head: true })
    .is("properties.archived_at", null);
});

export const getDashProperties = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number, neighborhood")
    .is("archived_at", null)
    // Only feeds the cleaning worklist; paused properties skip cleaning.
    .is("paused_at", null);
});

export const getDashRooms = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("rooms")
    .select(
      `id, room_number, status, available_from,
       total_rent, pending_tenant, listing_action,
       properties!inner(building_name, street_address, unit_number, archived_at)`,
    )
    .is("properties.archived_at", null);
});

export const getDashCleanings = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("cleaning_records")
    .select("id, property_id, cleaning_date, kind")
    .order("cleaning_date", { ascending: false });
});

export const getDashTenancies = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at, lease_end_date, status,
       rooms(room_number, properties(building_name, street_address, unit_number)),
       tenants(full_name, email, phone)`,
    )
    .eq("status", "active");
});

export const getAllPayments = cache(async () => {
  const supabase = await getCachedClient();
  return supabase
    .from("payments")
    .select("tenancy_id, amount, paid_on, payment_type");
});

export const getRoomAds = cache(async () => {
  const supabase = await getCachedClient();
  return supabase.from("room_ads").select("room_id, posted_by");
});

export const getDashSidecars = cache(async () =>
  fetchLedgerSidecars(await getCachedClient()),
);

// Group all payments by tenancy for the running ledger, and tally this
// month's rent collection for the KPI. "Collected this month" follows the
// rent cycle (27th → 26th), since tenants pay from the 27th. Per tenancy,
// security_deposit charges applied this cycle are deducted from rent-typed
// payments — mirrors the Rent Tracker KPIs: Zelle can't tell deposits from
// rent, so the applied charge is what marks that money as deposit.
export const getPaymentsThisCycle = cache(async () => {
  const [paymentsRes, { charges }] = await Promise.all([
    getAllPayments(),
    getDashSidecars(),
  ]);
  // Money integrity: a failed payments read throws rather than reporting
  // $0 collected and every tenant as owing.
  if (paymentsRes.error) {
    throw new LedgerDataError("payments", paymentsRes.error.message);
  }
  const data = paymentsRes.data;
  const today = todayISO();
  const tm = currentRentCycle();
  const inCycle = (d: string | null | undefined) =>
    !!d && d >= tm.start && d <= tm.end && d <= today;
  const paymentsByTenancy = new Map<
    string,
    { amount: number; paid_on: string; payment_type: string }[]
  >();
  const rentPaidByTenancy = new Map<string, number>();
  for (const pmt of data ?? []) {
    const list = paymentsByTenancy.get(pmt.tenancy_id);
    if (list) list.push(pmt);
    else paymentsByTenancy.set(pmt.tenancy_id, [pmt]);
    if (
      (pmt.payment_type === "rent" || pmt.payment_type === "refund") &&
      inCycle(pmt.paid_on)
    ) {
      rentPaidByTenancy.set(
        pmt.tenancy_id,
        (rentPaidByTenancy.get(pmt.tenancy_id) ?? 0) +
          (pmt.payment_type === "refund" ? -1 : 1) * Number(pmt.amount),
      );
    }
  }
  let collectedThisMonth = 0;
  for (const [tenancyId, paid] of rentPaidByTenancy) {
    const depositCharged = (charges.get(tenancyId) ?? [])
      .filter((c) => c.kind === "security_deposit" && inCycle(c.charged_on))
      .reduce((s, c) => s + Number(c.amount), 0);
    collectedThisMonth += Math.max(0, paid - depositCharged);
  }
  return { paymentsByTenancy, collectedThisMonth };
});

export type RentEntry = {
  tenant_id: string;
  tenant_name: string;
  unit: string;
  room: string;
  outstanding: number;
};

// Rent worklist: active tenancies whose running net balance is positive.
export const getRentWorklist = cache(async (): Promise<RentEntry[]> => {
  const [tenanciesRes, { paymentsByTenancy }, sidecars, tl] =
    await Promise.all([
      getDashTenancies(),
      getPaymentsThisCycle(),
      getDashSidecars(),
      fetchTenantLedgers(await getCachedClient()),
    ]);
  if (tenanciesRes.error) {
    throw new LedgerDataError("active tenancies", tenanciesRes.error.message);
  }
  const tenancies = tenanciesRes.data;
  const { charges, allocations, rentChanges } = sidecars;
  const today = todayISO();

  const rentWorklist: RentEntry[] = [];
  for (const t of (tenancies ?? []) as TenancyRow[]) {
    // Tenant-wide: one ledger per tenant across every room they've had.
    const { netBalance } = tenantLedger(tl, t.tenant_id, () =>
      computeLedger(
        t,
        paymentsByTenancy.get(t.id) ?? [],
        charges.get(t.id) ?? [],
        allocations.get(t.id) ?? [],
        today,
        rentChanges.get(t.id) ?? [],
      ),
    );
    if (netBalance <= 0.01) continue;
    const room = one(t.rooms);
    const tenant = one(t.tenants);
    rentWorklist.push({
      tenant_id: t.tenant_id,
      tenant_name: tenant?.full_name ?? "—",
      unit: unitLabel(one(room?.properties ?? null)),
      room: room?.room_number ?? "Room",
      outstanding: netBalance,
    });
  }
  rentWorklist.sort((a, b) => b.outstanding - a.outstanding);
  return rentWorklist;
});
