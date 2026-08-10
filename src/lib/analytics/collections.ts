/**
 * Historic rent-collection analytics. Used by /reports and by the
 * portal-tools / MCP tools so an agent can answer questions like
 * "how much did we collect last quarter?".
 *
 * "Expected" for a month = sum of each active tenancy's due for that
 * month (first_month_rent if it's the tenancy's starting month, else the
 * monthly rate in effect that month per tenancy_rent_history). "Collected"
 * = rent receipts less refunds in that calendar month.
 */

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { rateForMonthISO, type RentChange } from "@/lib/rent";

export type CollectionRow = {
  month: string; // "YYYY-MM"
  expected: number;
  collected: number;
  outstanding: number;
};

export type PropertyCollectionRow = {
  property_id: string;
  property_label: string;
  expected: number;
  collected: number;
  outstanding: number;
};

export type CollectionSummary = {
  this_month: CollectionRow;
  ytd: { expected: number; collected: number; outstanding: number };
  lifetime: { collected: number; payment_count: number };
};

function monthBoundsLocal(yyyymm: string): { start: string; end: string } {
  const [y, m] = yyyymm.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function todayMonth(): string {
  return todayISO().slice(0, 7);
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function listMonths(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const [sy, sm] = startISO.slice(0, 7).split("-").map(Number);
  const [ey, em] = endISO.slice(0, 7).split("-").map(Number);
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

type TenancyForMonth = {
  id: string;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  monthly_rent: number;
  first_month_rent: number | null;
  /** Rent-rate history so past months bill the rate in effect back then. */
  rent_changes: RentChange[];
};

function dueForMonth(t: TenancyForMonth, monthStart: string, monthEnd: string): number {
  // Tenancy doesn't overlap the month.
  if (t.start_date > monthEnd) return 0;
  if (t.move_out_date && t.move_out_date < monthStart) return 0;
  // Mirrors rentDue's pause freeze: paused months owe nothing.
  if (t.paused_at && monthStart >= t.paused_at.slice(0, 10)) return 0;
  const isStartingMonth =
    t.start_date >= monthStart && t.start_date <= monthEnd;
  if (isStartingMonth && t.first_month_rent !== null) {
    return Number(t.first_month_rent);
  }
  return rateForMonthISO(monthStart, t.monthly_rent, t.rent_changes);
}

type RawTenancy = {
  id: string;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  monthly_rent: number;
  first_month_rent: number | null;
};

type CollectionPayment = {
  amount: number;
  paid_on: string;
  payment_type: string;
};

// Attach each tenancy's rent-rate history so dueForMonth can bill past months
// at the rate in effect back then (same pattern as rent-data.ts).
async function withRentChanges(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenancies: RawTenancy[],
): Promise<TenancyForMonth[]> {
  if (tenancies.length === 0) return [];
  const { data: histRows } = await supabase
    .from("tenancy_rent_history")
    .select("tenancy_id, effective_month, monthly_rent")
    .in("tenancy_id", tenancies.map((t) => t.id));
  const byTenancy = new Map<string, RentChange[]>();
  for (const r of histRows ?? []) {
    const change = {
      effective_month: r.effective_month,
      monthly_rent: r.monthly_rent,
    };
    const list = byTenancy.get(r.tenancy_id);
    if (list) list.push(change);
    else byTenancy.set(r.tenancy_id, [change]);
  }
  return tenancies.map((t) => ({
    ...t,
    rent_changes: byTenancy.get(t.id) ?? [],
  }));
}

/** Resolve a property-IDs filter into the tenancies + payments those rooms had.
 *  cache()d per request: /reports calls this from both getCollectionSummary and
 *  getMonthlyCollections with the same filter — the second call reuses the
 *  first's full-table scan instead of repeating it. */
const loadFilteredHistory = cache(async (propertyIds?: string[]) => {
  const supabase = await createClient();
  if (propertyIds && propertyIds.length > 0) {
    const { data: rooms } = await supabase
      .from("rooms")
      .select("id")
      .in("property_id", propertyIds);
    const roomIds = (rooms ?? []).map((r) => r.id);
    if (roomIds.length === 0) return { tenancies: [], payments: [] };

    const { data: tenancies } = await supabase
      .from("tenancies")
      .select("id, start_date, move_out_date, paused_at, monthly_rent, first_month_rent")
      .in("room_id", roomIds);

    const tenancyIds = (tenancies ?? []).map((t) => t.id);
    if (tenancyIds.length === 0) return { tenancies: [], payments: [] };

    const { data: payments } = await supabase
      .from("payments")
      .select("amount, paid_on, payment_type")
      .in("payment_type", ["rent", "refund"])
      .in("tenancy_id", tenancyIds);

    return {
      tenancies: await withRentChanges(supabase, tenancies ?? []),
      payments: payments ?? [],
    };
  }

  const [{ data: tenancies }, { data: payments }] = await Promise.all([
    supabase
      .from("tenancies")
      .select("id, start_date, move_out_date, paused_at, monthly_rent, first_month_rent"),
    supabase
      .from("payments")
      .select("amount, paid_on, payment_type")
      .in("payment_type", ["rent", "refund"]),
  ]);
  return {
    tenancies: await withRentChanges(supabase, tenancies ?? []),
    payments: payments ?? [],
  };
});

/**
 * Per-month collection table from earliestStartISO through endMonth (default
 * this month). Includes months with zero activity so the timeline is dense.
 */
export async function getMonthlyCollections(
  fromMonth?: string,
  toMonth?: string,
  propertyIds?: string[],
): Promise<CollectionRow[]> {
  const supabase = await createClient();
  const today = todayMonth();
  const end = toMonth ?? today;

  // If no fromMonth, use the earliest tenancy start.
  let from = fromMonth;
  if (!from) {
    const { data } = await supabase
      .from("tenancies")
      .select("start_date")
      .order("start_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    from = data?.start_date?.slice(0, 7) ?? end;
  }

  const months = listMonths(`${from}-01`, `${end}-01`);

  const { tenancies, payments } = await loadFilteredHistory(propertyIds);

  const collectedByMonth = new Map<string, number>();
  const asOf = todayISO();
  for (const p of payments as CollectionPayment[]) {
    if (p.paid_on > asOf) continue;
    const key = monthOf(p.paid_on);
    const signed = p.payment_type === "refund" ? -Number(p.amount) : Number(p.amount);
    collectedByMonth.set(key, (collectedByMonth.get(key) ?? 0) + signed);
  }

  return months.map((m) => {
    const { start, end } = monthBoundsLocal(m);
    const expected = tenancies.reduce(
      (sum, t) => sum + dueForMonth(t, start, end),
      0,
    );
    const collected = collectedByMonth.get(m) ?? 0;
    return {
      month: m,
      expected,
      collected,
      outstanding: expected - collected,
    };
  });
}

/** Headline KPIs for /reports. */
export async function getCollectionSummary(
  propertyIds?: string[],
): Promise<CollectionSummary> {
  const today = todayISO();
  const year = today.slice(0, 4);
  const thisMonth = today.slice(0, 7);
  const ytdStart = `${year}-01-01`;

  const { tenancies, payments } = await loadFilteredHistory(propertyIds);

  const months = listMonths(ytdStart, `${thisMonth}-01`);

  let ytdExpected = 0;
  for (const m of months) {
    const { start, end } = monthBoundsLocal(m);
    ytdExpected += tenancies.reduce(
      (s, t) => s + dueForMonth(t, start, end),
      0,
    );
  }

  let ytdCollected = 0;
  let lifetimeCollected = 0;
  let paymentCount = 0;
  let thisMonthCollected = 0;
  for (const p of payments as CollectionPayment[]) {
    if (p.paid_on > today) continue;
    const amt =
      (p.payment_type === "refund" ? -1 : 1) * Number(p.amount);
    lifetimeCollected += amt;
    if (p.payment_type === "rent") paymentCount++;
    if (p.paid_on >= ytdStart) ytdCollected += amt;
    if (monthOf(p.paid_on) === thisMonth) thisMonthCollected += amt;
  }

  const tmBounds = monthBoundsLocal(thisMonth);
  const thisMonthExpected = tenancies.reduce(
    (s, t) => s + dueForMonth(t, tmBounds.start, tmBounds.end),
    0,
  );

  return {
    this_month: {
      month: thisMonth,
      expected: thisMonthExpected,
      collected: thisMonthCollected,
      outstanding: thisMonthExpected - thisMonthCollected,
    },
    ytd: {
      expected: ytdExpected,
      collected: ytdCollected,
      outstanding: ytdExpected - ytdCollected,
    },
    lifetime: {
      collected: lifetimeCollected,
      payment_count: paymentCount,
    },
  };
}

/** Per-property collected revenue (lifetime by default). */
export async function getPropertyCollections(
  fromISO?: string,
  toISO?: string,
  propertyIds?: string[],
): Promise<PropertyCollectionRow[]> {
  const supabase = await createClient();

  type PaymentRow = {
    amount: number | string;
    paid_on: string;
    payment_type: string;
    tenancies: {
      rooms: {
        properties: {
          id: string;
          building_name: string | null;
          street_address: string;
          unit_number: string;
        } | { id: string; building_name: string | null; street_address: string; unit_number: string }[] | null;
      } | { properties: { id: string; building_name: string | null; street_address: string; unit_number: string } | { id: string; building_name: string | null; street_address: string; unit_number: string }[] | null }[] | null;
    } | null;
  };

  let q = supabase
    .from("payments")
    .select(
      `amount, paid_on, payment_type,
       tenancies!inner(
         rooms!inner(
           properties!inner(id, building_name, street_address, unit_number)
         )
       )`,
    )
    .in("payment_type", ["rent", "refund"]);

  if (fromISO) q = q.gte("paid_on", fromISO);
  q = q.lte("paid_on", toISO ?? todayISO());

  const { data } = await q.returns<PaymentRow[]>();

  const allow = propertyIds && propertyIds.length > 0 ? new Set(propertyIds) : null;

  type Totals = { collected: number; label: string };
  const byProperty = new Map<string, Totals>();
  for (const row of data ?? []) {
    const tenancy = row.tenancies;
    if (!tenancy) continue;
    const room = Array.isArray(tenancy) ? tenancy[0]?.rooms : tenancy.rooms;
    if (!room) continue;
    const props = Array.isArray(room) ? room[0]?.properties : room.properties;
    const property = props ? (Array.isArray(props) ? props[0] : props) : null;
    if (!property) continue;
    if (allow && !allow.has(property.id)) continue;
    const label = `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`;
    const prev = byProperty.get(property.id) ?? { collected: 0, label };
    prev.collected +=
      (row.payment_type === "refund" ? -1 : 1) * Number(row.amount);
    byProperty.set(property.id, prev);
  }

  return Array.from(byProperty.entries())
    .map(([id, v]) => ({
      property_id: id,
      property_label: v.label,
      expected: 0, // computing per-property expected is expensive; defer
      collected: v.collected,
      outstanding: 0,
    }))
    .sort((a, b) => b.collected - a.collected);
}

export type PropertyOption = {
  id: string;
  label: string;
  neighborhood: string | null;
};

/** Property options for the /reports filter dropdowns. */
export async function getPropertyOptions(): Promise<PropertyOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number, neighborhood")
    .order("building_name", { ascending: true, nullsFirst: false })
    .order("street_address", { ascending: true });

  return (data ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
    neighborhood: p.neighborhood,
  }));
}

// Tiny re-export so other modules can call one() if needed.
export { one };
