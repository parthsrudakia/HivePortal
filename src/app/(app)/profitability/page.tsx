import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canViewProfitability } from "@/lib/access";
import { todayISO } from "@/lib/date";
import { one } from "@/lib/relations";
import { billMonth, type BillRow } from "@/lib/utility-bills";

export const dynamic = "force-dynamic";

// Mirrors the operator's "Profitability <year>" workbook: one grid per
// metric — units down, Jan–Dec across (grouped by quarter) with a year
// Total — switched by pill tabs. Profit is the derived view.

type PageProps = {
  searchParams: Promise<{ year?: string; view?: string }>;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const VIEWS = [
  { key: "profit", label: "Profit" },
  { key: "collection", label: "Rent Collection" },
  { key: "rent_paid", label: "Rent Paid" },
  { key: "utilities", label: "Utilities" },
  { key: "internet", label: "Internet" },
  { key: "cleaning", label: "Cleaning" },
  { key: "amenity", label: "Amenity Fees" },
  { key: "misc", label: "Misc Fees" },
  { key: "insurance", label: "Insurance" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

/** One metric cell: null = no data / out of lease; estimated = ~ prefix. */
type Cell = { value: number; estimated: boolean } | null;

type UnitGrid = {
  id: string;
  label: string;
  cells: Cell[]; // 12 entries
  total: number | null;
};

function fmtMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export default async function ProfitabilityPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canViewProfitability(user?.email)) notFound();

  const sp = await searchParams;
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const year = /^\d{4}$/.test(sp.year ?? "")
    ? Number(sp.year)
    : currentYear;
  const view: ViewKey = (VIEWS.find((v) => v.key === sp.view)?.key ??
    "profit") as ViewKey;

  // Last month that can hold data: December for past years, the current
  // month for the current year, none for future years.
  const lastMonthIdx =
    year < currentYear ? 11 : year > currentYear ? -1 : Number(today.slice(5, 7)) - 1;

  type PropertyRow = {
    id: string;
    building_name: string | null;
    street_address: string;
    unit_number: string;
    bedrooms: number | null;
    unit_rent: number | null;
    unit_lease_start: string | null;
    unit_lease_end: string | null;
    amenity_fees_yearly: number | null;
    misc_fees_yearly: number | null;
    internet_monthly: number | null;
    cleaning_fee_monthly: number | null;
    insurance_monthly: number | null;
  };
  type PaymentRow = {
    amount: number | string;
    paid_on: string;
    payment_type: string;
    tenancies:
      | { rooms: { property_id: string | null } | { property_id: string | null }[] | null }
      | { rooms: { property_id: string | null } | { property_id: string | null }[] | null }[]
      | null;
  };

  const [{ data: properties }, { data: payments }, { data: bills }] =
    await Promise.all([
      supabase
        .from("properties")
        .select(
          `id, building_name, street_address, unit_number, bedrooms,
           unit_rent, unit_lease_start, unit_lease_end,
           amenity_fees_yearly, misc_fees_yearly,
           internet_monthly, cleaning_fee_monthly, insurance_monthly`,
        )
        .order("street_address")
        .returns<PropertyRow[]>(),
      supabase
        .from("payments")
        .select(
          "amount, paid_on, payment_type, tenancies!inner(rooms!inner(property_id))",
        )
        .gte("paid_on", `${year}-01-01`)
        .lte("paid_on", `${year}-12-31`)
        .returns<PaymentRow[]>(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("utility_bills")
        .select(
          "id, property_id, provider, utility_type, account_number, service_address, statement_date, period_start, period_end, total_amount, overage_dismissed, overage_charged_at, notes, created_at, utility_bill_charges(id, kind, description, amount)",
        ) as Promise<{ data: BillRow[] | null }>,
    ]);

  const props = properties ?? [];
  const monthKey = (m: number) => `${year}-${String(m + 1).padStart(2, "0")}`;

  // A unit is "active" in a month when the month overlaps its lease window
  // (missing dates = unbounded, matching the sheet where a unit's columns
  // simply stop after the lease ends).
  const activeIn = (p: PropertyRow, m: number): boolean => {
    const key = monthKey(m);
    if (p.unit_lease_start && p.unit_lease_start.slice(0, 7) > key) return false;
    if (p.unit_lease_end && p.unit_lease_end.slice(0, 7) < key) return false;
    return true;
  };

  // Revenue collected per unit per month: every tenant payment dated inside
  // the calendar month, security deposits excluded, refunds subtracting.
  const collection = new Map<string, number[]>(
    props.map((p) => [p.id, Array(12).fill(0)]),
  );
  for (const pay of payments ?? []) {
    const propertyId = one(one(pay.tenancies)?.rooms ?? null)?.property_id;
    if (!propertyId) continue;
    if (pay.payment_type === "security_deposit") continue;
    const arr = collection.get(propertyId);
    if (!arr) continue;
    const m = Number(pay.paid_on.slice(5, 7)) - 1;
    arr[m] += (pay.payment_type === "refund" ? -1 : 1) * Number(pay.amount);
  }

  // Actual utility spend per unit per month (bills attributed to the month
  // holding most of their billing period).
  const utilityActual = new Map<string, (number | undefined)[]>(
    props.map((p) => [p.id, Array(12).fill(undefined)]),
  );
  for (const b of bills ?? []) {
    if (!b.property_id) continue;
    const bm = billMonth(b);
    if (bm.slice(0, 4) !== String(year)) continue;
    const arr = utilityActual.get(b.property_id);
    if (!arr) continue;
    const m = Number(bm.slice(5, 7)) - 1;
    arr[m] = (arr[m] ?? 0) + Number(b.total_amount);
  }

  // Per-month estimate for units with no bill: average of that month's
  // actuals across units with the same bedroom count, falling back to all
  // units — the sheet's "Average Taken" rows.
  const estimateFor = (p: PropertyRow, m: number): number | null => {
    const similar: number[] = [];
    const all: number[] = [];
    for (const q of props) {
      const v = utilityActual.get(q.id)?.[m];
      if (v === undefined) continue;
      all.push(v);
      if ((q.bedrooms ?? null) === (p.bedrooms ?? null)) similar.push(v);
    }
    const pool = similar.length > 0 ? similar : all;
    if (pool.length === 0) return null;
    return pool.reduce((s, x) => s + x, 0) / pool.length;
  };

  // Build the requested metric's grid (profit derives from all of them).
  const flatMonthly = (p: PropertyRow, amount: number | null) => (m: number): Cell =>
    amount === null || !activeIn(p, m) || m > lastMonthIdx
      ? null
      : { value: Number(amount), estimated: false };

  const cellBuilders: Record<ViewKey, (p: PropertyRow) => (m: number) => Cell> = {
    collection: (p) => (m) =>
      m > lastMonthIdx ? null : { value: collection.get(p.id)?.[m] ?? 0, estimated: false },
    rent_paid: (p) => flatMonthly(p, p.unit_rent),
    utilities: (p) => (m) => {
      if (m > lastMonthIdx || !activeIn(p, m)) return null;
      const actual = utilityActual.get(p.id)?.[m];
      if (actual !== undefined) return { value: actual, estimated: false };
      const est = estimateFor(p, m);
      return est === null ? null : { value: est, estimated: true };
    },
    internet: (p) => flatMonthly(p, p.internet_monthly),
    cleaning: (p) => flatMonthly(p, p.cleaning_fee_monthly),
    amenity: (p) =>
      flatMonthly(p, p.amenity_fees_yearly !== null ? Number(p.amenity_fees_yearly) / 12 : null),
    misc: (p) =>
      flatMonthly(p, p.misc_fees_yearly !== null ? Number(p.misc_fees_yearly) / 12 : null),
    insurance: (p) => flatMonthly(p, p.insurance_monthly),
    profit: (p) => (m) => {
      if (m > lastMonthIdx) return null;
      const active = activeIn(p, m);
      const revenue = collection.get(p.id)?.[m] ?? 0;
      if (!active && revenue === 0) return null;
      const costs: Cell[] = [
        cellBuilders.rent_paid(p)(m),
        cellBuilders.utilities(p)(m),
        cellBuilders.internet(p)(m),
        cellBuilders.cleaning(p)(m),
        cellBuilders.amenity(p)(m),
        cellBuilders.misc(p)(m),
        cellBuilders.insurance(p)(m),
      ];
      let value = revenue;
      let estimated = false;
      for (const c of costs) {
        if (!c) continue;
        value -= c.value;
        estimated = estimated || c.estimated;
      }
      return { value, estimated };
    },
  };

  const grid: UnitGrid[] = props.map((p) => {
    const build = cellBuilders[view](p);
    const cells = MONTHS.map((_, m) => build(m));
    const present = cells.filter((c): c is NonNullable<Cell> => c !== null);
    return {
      id: p.id,
      label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
      cells,
      total:
        present.length > 0
          ? present.reduce((s, c) => s + c.value, 0)
          : null,
    };
  });

  // Column totals (footer), summed over units with data in that month.
  const columnTotals: (number | null)[] = MONTHS.map((_, m) => {
    const vals = grid.map((r) => r.cells[m]).filter((c): c is NonNullable<Cell> => c !== null);
    return vals.length > 0 ? vals.reduce((s, c) => s + c.value, 0) : null;
  });
  const grandTotal = grid.reduce((s, r) => s + (r.total ?? 0), 0);
  const anyEstimates = grid.some((r) => r.cells.some((c) => c?.estimated));

  const isProfit = view === "profit";
  const valueCls = (c: NonNullable<Cell>) =>
    c.estimated
      ? "text-accent-text"
      : isProfit && c.value < -0.005
        ? "text-red-700"
        : isProfit && c.value > 0.005
          ? "text-green-800"
          : "text-ink";

  return (
    <div className="mx-auto w-full max-w-none">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            Unit{" "}
            <span className="font-display text-accent-text">profitability</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Units by month, one grid per metric — profit is revenue collected
            minus rent paid, utilities, internet, cleaning, amenity, misc, and
            insurance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/profitability?year=${year - 1}&view=${view}`}
            aria-label="Previous year"
            className="rounded-full border border-stone bg-white px-3 py-1.5 text-sm text-ink hover:bg-warm"
          >
            ←
          </Link>
          <span className="min-w-16 text-center text-sm font-medium text-ink">
            {year}
          </span>
          {year < currentYear ? (
            <Link
              href={`/profitability?year=${year + 1}&view=${view}`}
              aria-label="Next year"
              className="rounded-full border border-stone bg-white px-3 py-1.5 text-sm text-ink hover:bg-warm"
            >
              →
            </Link>
          ) : (
            <span className="rounded-full border border-stone/40 bg-white px-3 py-1.5 text-sm text-muted/50">
              →
            </span>
          )}
        </div>
      </header>

      <nav className="mt-6 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={`/profitability?year=${year}&view=${v.key}`}
            className={
              v.key === view
                ? "rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white"
                : "rounded-full border border-stone bg-white px-4 py-1.5 text-sm text-ink hover:bg-warm"
            }
          >
            {v.label}
          </Link>
        ))}
      </nav>

      <section className="mt-6 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="bg-warm/60">
              <th className="rounded-tl-2xl px-4 py-2" />
              {[1, 2, 3, 4].map((q) => (
                <th key={q} colSpan={3} className="px-3 py-2 text-center font-medium">
                  Q{q} {year}
                </th>
              ))}
              <th className="rounded-tr-2xl px-4 py-2" />
            </tr>
            <tr className="bg-warm">
              <th className="sticky left-0 z-10 bg-warm px-4 py-2.5 text-left font-medium">
                Unit
              </th>
              {MONTHS.map((mo) => (
                <th key={mo} className="px-3 py-2.5 text-right font-medium">
                  {mo}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.map((r) => (
              <tr key={r.id} className="border-t border-stone/40">
                <td className="sticky left-0 z-10 max-w-52 truncate bg-white px-4 py-3">
                  <Link
                    href={`/properties/${r.id}`}
                    className="text-ink hover:text-accent-text"
                    title={r.label}
                  >
                    {r.label}
                  </Link>
                </td>
                {r.cells.map((c, m) => (
                  <td
                    key={m}
                    className="px-3 py-3 text-right tabular-nums"
                    title={c?.estimated ? "Estimated — average of similar units" : undefined}
                  >
                    {c === null ? (
                      <span className="text-muted/40">—</span>
                    ) : (
                      <span className={valueCls(c)}>
                        {c.estimated ? "~" : ""}
                        {fmtMoney(c.value)}
                      </span>
                    )}
                  </td>
                ))}
                <td
                  className={`px-4 py-3 text-right font-semibold tabular-nums ${
                    r.total !== null && isProfit
                      ? r.total < -0.005
                        ? "text-red-700"
                        : "text-green-800"
                      : "text-ink"
                  }`}
                >
                  {r.total !== null ? fmtMoney(r.total) : "—"}
                </td>
              </tr>
            ))}
            {grid.length === 0 && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-muted">
                  No properties yet.
                </td>
              </tr>
            )}
          </tbody>
          {grid.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-stone/60 bg-warm/40 font-semibold">
                <td className="sticky left-0 z-10 rounded-bl-2xl bg-warm/40 px-4 py-3 text-ink backdrop-blur">
                  Total
                </td>
                {columnTotals.map((t, m) => (
                  <td
                    key={m}
                    className={`px-3 py-3 text-right tabular-nums ${
                      t !== null && isProfit
                        ? t < -0.005
                          ? "text-red-700"
                          : "text-green-800"
                        : "text-ink"
                    }`}
                  >
                    {t !== null ? fmtMoney(t) : ""}
                  </td>
                ))}
                <td
                  className={`rounded-br-2xl px-4 py-3 text-right tabular-nums ${
                    isProfit
                      ? grandTotal < -0.005
                        ? "text-red-700"
                        : "text-green-800"
                      : "text-ink"
                  }`}
                >
                  {fmtMoney(grandTotal)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      <p className="mt-4 max-w-4xl text-xs text-muted">
        Rent Collection is every tenant payment dated in the month (security
        deposits excluded, refunds subtracted). Rent Paid, Internet, Cleaning,
        and Insurance are the unit&apos;s flat monthly figures; Amenity and
        Misc are the yearly figures ÷ 12 — all from the property&apos;s Edit
        page, and shown only for months inside the unit&apos;s lease window.
        {anyEstimates && (
          <>
            {" "}
            <span className="text-accent-text">~ amounts</span> are estimates:
            no utility bill for that unit that month, so it uses the average
            of similar units (same bedroom count).
          </>
        )}
      </p>
    </div>
  );
}
