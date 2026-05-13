/**
 * Historic rent-collection analytics. Used by /reports and by the
 * portal-tools / MCP tools so an agent can answer questions like
 * "how much did we collect last quarter?".
 *
 * "Expected" for a month = sum of each active tenancy's due for that
 * month (first_month_rent if it's the tenancy's starting month, else
 * monthly_rent). "Collected" = sum of payments.payment_type='rent' in
 * that calendar month.
 */

import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";

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
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
  end_date: string | null;
  monthly_rent: number;
  first_month_rent: number | null;
};

function dueForMonth(t: TenancyForMonth, monthStart: string, monthEnd: string): number {
  // Tenancy doesn't overlap the month.
  if (t.start_date > monthEnd) return 0;
  if (t.end_date && t.end_date < monthStart) return 0;
  const isStartingMonth =
    t.start_date >= monthStart && t.start_date <= monthEnd;
  if (isStartingMonth && t.first_month_rent !== null) {
    return Number(t.first_month_rent);
  }
  return Number(t.monthly_rent);
}

/**
 * Per-month collection table from earliestStartISO through endMonth (default
 * this month). Includes months with zero activity so the timeline is dense.
 */
export async function getMonthlyCollections(
  fromMonth?: string,
  toMonth?: string,
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

  // Fetch every tenancy ever (we'll filter per-month).
  const { data: tenancies } = await supabase
    .from("tenancies")
    .select("id, start_date, end_date, monthly_rent, first_month_rent");
  // Fetch every rent payment (we'll bucket by month).
  const { data: payments } = await supabase
    .from("payments")
    .select("amount, paid_on")
    .eq("payment_type", "rent");

  const collectedByMonth = new Map<string, number>();
  for (const p of payments ?? []) {
    const key = monthOf(p.paid_on);
    collectedByMonth.set(key, (collectedByMonth.get(key) ?? 0) + Number(p.amount));
  }

  return months.map((m) => {
    const { start, end } = monthBoundsLocal(m);
    const expected = (tenancies ?? []).reduce(
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
export async function getCollectionSummary(): Promise<CollectionSummary> {
  const supabase = await createClient();
  const today = new Date();
  const year = today.getUTCFullYear();
  const thisMonth = `${year}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const ytdStart = `${year}-01-01`;

  const [{ data: tenancies }, { data: payments }] = await Promise.all([
    supabase
      .from("tenancies")
      .select("id, start_date, end_date, monthly_rent, first_month_rent"),
    supabase.from("payments").select("amount, paid_on").eq("payment_type", "rent"),
  ]);

  const months = listMonths(ytdStart, `${thisMonth}-01`);

  let ytdExpected = 0;
  for (const m of months) {
    const { start, end } = monthBoundsLocal(m);
    ytdExpected += (tenancies ?? []).reduce(
      (s, t) => s + dueForMonth(t, start, end),
      0,
    );
  }

  let ytdCollected = 0;
  let lifetimeCollected = 0;
  let paymentCount = 0;
  let thisMonthCollected = 0;
  for (const p of payments ?? []) {
    const amt = Number(p.amount);
    lifetimeCollected += amt;
    paymentCount++;
    if (p.paid_on >= ytdStart) ytdCollected += amt;
    if (monthOf(p.paid_on) === thisMonth) thisMonthCollected += amt;
  }

  const tmBounds = monthBoundsLocal(thisMonth);
  const thisMonthExpected = (tenancies ?? []).reduce(
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
): Promise<PropertyCollectionRow[]> {
  const supabase = await createClient();

  type PaymentRow = {
    amount: number | string;
    paid_on: string;
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
      `amount, paid_on,
       tenancies!inner(
         rooms!inner(
           properties!inner(id, building_name, street_address, unit_number)
         )
       )`,
    )
    .eq("payment_type", "rent");

  if (fromISO) q = q.gte("paid_on", fromISO);
  if (toISO) q = q.lte("paid_on", toISO);

  const { data } = await q.returns<PaymentRow[]>();

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
    const label = `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`;
    const prev = byProperty.get(property.id) ?? { collected: 0, label };
    prev.collected += Number(row.amount);
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

// Tiny re-export so other modules can call one() if needed.
export { one };
