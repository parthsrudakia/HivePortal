/**
 * Unit profitability — the shared computation behind the /profitability page
 * and the Telegram bot's get_profitability tool, so both always agree.
 *
 * One year at a time: units × months per metric, where Rent Collection is
 * every tenant payment dated in the calendar month (deposits excluded,
 * refunds subtracting), Rent Paid / Internet / Cleaning / Insurance are the
 * actual costs recorded for the month (profit_costs) or else the unit's flat
 * monthly figures, Amenity / Misc are the actual charges once a unit has any
 * for the year or else yearly ÷ 12, Company costs are the month's unit-less
 * profit_costs rows, and Utilities come from uploaded bills (months without
 * a bill fall back to the average of same-bedroom units — flagged
 * `estimated`). See profit-costs.ts for the actual-cost rules. Cells are null outside the
 * unit's lease window, for months that haven't happened yet, and for months
 * before PROFIT_DATA_START (no data was ever entered for them).
 */

import { one } from "@/lib/relations";
import { allLedgerRows } from "@/lib/rent-data";
import { billMonth, type BillRow } from "@/lib/utility-bills";
import {
  loadProfitCosts,
  UNIT_COST_TYPES,
  type UnitCostType,
} from "@/lib/profit-costs";

export const PROFIT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * The books start here (YYYY-MM). Months before this hold no input data, so
 * every metric renders them as blank rather than misleading zeros/estimates.
 */
export const PROFIT_DATA_START = "2026-06";
const START_YEAR = Number(PROFIT_DATA_START.slice(0, 4));
const START_MONTH_IDX = Number(PROFIT_DATA_START.slice(5, 7)) - 1;

export type ProfitCell = { value: number; estimated: boolean } | null;

export type ProfitMetric =
  | "profit"
  | "collection"
  | "rent_paid"
  | "utilities"
  | "internet"
  | "cleaning"
  | "amenity"
  | "misc"
  | "insurance";

export const EXPENSE_METRICS: {
  key: Exclude<ProfitMetric, "profit" | "collection">;
  label: string;
}[] = [
  { key: "rent_paid", label: "Rent paid" },
  { key: "utilities", label: "Utilities" },
  { key: "internet", label: "Internet" },
  { key: "cleaning", label: "Cleaning" },
  { key: "amenity", label: "Amenity fees" },
  { key: "misc", label: "Misc fees" },
  { key: "insurance", label: "Insurance" },
];

export type ProfitUnit = {
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

/** A summary expense line: the unit metrics plus company-wide costs. */
export type ExpenseSeriesKey =
  | Exclude<ProfitMetric, "profit" | "collection">
  | "company";

/** One label's yearly total within Company costs (e.g. Upwork). */
export type CompanyCostItem = { label: string; yearly: number };

export type ProfitLineItem = {
  id: string;
  side: "revenue" | "expense";
  label: string;
  amount: number;
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

// Works with both the cookie-session server client and the service-role
// client; some tables involved post-date the generated types anyway.
type Client = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

export function profitUnitLabel(p: ProfitUnit): string {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

export type ProfitabilityData = {
  year: number;
  /** First month index (0-11) that can hold data; 12 for pre-data years. */
  firstMonthIdx: number;
  /** Last month index (0-11) that can hold data; -1 for future years. */
  lastMonthIdx: number;
  units: ProfitUnit[];
  lineItems: ProfitLineItem[];
  /** Per-unit month cells for a metric. */
  cellFor: (metric: ProfitMetric, p: ProfitUnit) => (m: number) => ProfitCell;
  /** Column totals across all units for a metric. */
  monthlyTotalOf: (metric: ProfitMetric) => (number | null)[];
  summary: {
    monthlyRevenue: (number | null)[];
    monthlyExpenses: (number | null)[];
    monthlyNet: (number | null)[];
    expenseSeries: {
      key: ExpenseSeriesKey;
      label: string;
      monthly: (number | null)[];
      yearly: number;
    }[];
    /** Company costs by label for the year, largest first. */
    companyItems: CompanyCostItem[];
    unitRevenueYear: number;
    revenueItems: ProfitLineItem[];
    expenseItems: ProfitLineItem[];
    totalRevenue: number;
    totalExpenses: number;
    netTotal: number;
  };
};

export async function loadProfitability(
  supabase: Client,
  year: number,
  todayIso: string,
): Promise<ProfitabilityData> {
  const currentYear = Number(todayIso.slice(0, 4));
  const lastMonthIdx =
    year < currentYear
      ? 11
      : year > currentYear
        ? -1
        : Number(todayIso.slice(5, 7)) - 1;
  const firstMonthIdx =
    year > START_YEAR ? 0 : year === START_YEAR ? START_MONTH_IDX : 12;
  const inRange = (m: number) => m >= firstMonthIdx && m <= lastMonthIdx;

  // Payments and bills outgrow the 1,000-row response cap, so they page
  // through allLedgerRows (exact count, stable order) instead of one select.
  const [
    { data: properties },
    payments,
    bills,
    { data: lineItemRows },
    costRows,
  ] = await Promise.all([
    supabase
      .from("properties")
      .select(
        `id, building_name, street_address, unit_number, bedrooms,
         unit_rent, unit_lease_start, unit_lease_end,
         amenity_fees_yearly, misc_fees_yearly,
         internet_monthly, cleaning_fee_monthly, insurance_monthly`,
      )
      .order("street_address") as Promise<{ data: ProfitUnit[] | null }>,
    allLedgerRows<PaymentRow>("payments", (from, to) =>
      supabase
        .from("payments")
        .select(
          "amount, paid_on, payment_type, tenancies!inner(rooms!inner(property_id))",
          { count: "exact" },
        )
        .gte("paid_on", `${year}-01-01`)
        .lte("paid_on", `${year}-12-31`)
        .order("id")
        .range(from, to),
    ),
    allLedgerRows<BillRow>("utility bills", (from, to) =>
      supabase
        .from("utility_bills")
        .select(
          "id, property_id, provider, utility_type, account_number, service_address, statement_date, period_start, period_end, total_amount, overage_dismissed, overage_charged_at, notes, created_at, utility_bill_charges(id, kind, description, amount)",
          { count: "exact" },
        )
        .order("id")
        .range(from, to),
    ),
    supabase
      .from("profitability_line_items")
      .select("id, side, label, amount")
      .eq("year", year)
      .order("created_at") as Promise<{ data: ProfitLineItem[] | null }>,
    loadProfitCosts(supabase, year),
  ]);

  const units = properties ?? [];
  const lineItems = lineItemRows ?? [];
  const monthKey = (m: number) => `${year}-${String(m + 1).padStart(2, "0")}`;

  // A unit is "active" in a month when the month overlaps its lease window
  // (missing dates = unbounded).
  const activeIn = (p: ProfitUnit, m: number): boolean => {
    const key = monthKey(m);
    if (p.unit_lease_start && p.unit_lease_start.slice(0, 7) > key) return false;
    if (p.unit_lease_end && p.unit_lease_end.slice(0, 7) < key) return false;
    return true;
  };

  // Revenue collected per unit per month.
  const collection = new Map<string, number[]>(
    units.map((p) => [p.id, Array(12).fill(0)]),
  );
  for (const pay of payments) {
    const propertyId = one(one(pay.tenancies)?.rooms ?? null)?.property_id;
    if (!propertyId) continue;
    if (pay.payment_type === "security_deposit") continue;
    const arr = collection.get(propertyId);
    if (!arr) continue;
    const m = Number(pay.paid_on.slice(5, 7)) - 1;
    arr[m] += (pay.payment_type === "refund" ? -1 : 1) * Number(pay.amount);
  }

  // Actual utility spend per unit per month.
  const utilityActual = new Map<string, (number | undefined)[]>(
    units.map((p) => [p.id, Array(12).fill(undefined)]),
  );
  for (const b of bills) {
    if (!b.property_id) continue;
    const bm = billMonth(b);
    if (bm.slice(0, 4) !== String(year)) continue;
    const arr = utilityActual.get(b.property_id);
    if (!arr) continue;
    const m = Number(bm.slice(5, 7)) - 1;
    arr[m] = (arr[m] ?? 0) + Number(b.total_amount);
  }

  // Actual costs per unit, type and month; company costs per month and label.
  const actual = new Map<string, Map<UnitCostType, (number | undefined)[]>>();
  const companyMonthlyRaw: number[] = Array(12).fill(0);
  const companyByLabel = new Map<string, number>();
  for (const c of costRows) {
    if (c.month.slice(0, 4) !== String(year)) continue;
    const m = Number(c.month.slice(5, 7)) - 1;
    const amount = Number(c.amount);
    if (c.cost_type === "company") {
      // Same window as every other figure: nothing before the books start
      // or in months that haven't happened yet.
      if (!inRange(m)) continue;
      companyMonthlyRaw[m] += amount;
      const label = c.label?.trim() || "Other";
      companyByLabel.set(label, (companyByLabel.get(label) ?? 0) + amount);
      continue;
    }
    if (!c.property_id) continue;
    if (!(UNIT_COST_TYPES as readonly string[]).includes(c.cost_type)) continue;
    let byType = actual.get(c.property_id);
    if (!byType) actual.set(c.property_id, (byType = new Map()));
    let arr = byType.get(c.cost_type);
    if (!arr) byType.set(c.cost_type, (arr = Array(12).fill(undefined)));
    arr[m] = (arr[m] ?? 0) + amount;
  }
  const actualFor = (p: ProfitUnit, type: UnitCostType) =>
    actual.get(p.id)?.get(type);

  // Same-bedroom average (falling back to all units) for months with no bill.
  const estimateFor = (p: ProfitUnit, m: number): number | null => {
    const similar: number[] = [];
    const all: number[] = [];
    for (const q of units) {
      const v = utilityActual.get(q.id)?.[m];
      if (v === undefined) continue;
      all.push(v);
      if ((q.bedrooms ?? null) === (p.bedrooms ?? null)) similar.push(v);
    }
    const pool = similar.length > 0 ? similar : all;
    if (pool.length === 0) return null;
    return pool.reduce((s, x) => s + x, 0) / pool.length;
  };

  const flatMonthly =
    (p: ProfitUnit, amount: number | null) =>
    (m: number): ProfitCell =>
      amount === null || !activeIn(p, m) || !inRange(m)
        ? null
        : { value: Number(amount), estimated: false };

  // A recorded cost for the month wins over the flat figure. Actual rows are
  // real money, so they show even outside the unit's lease window.
  const actualOrFlat =
    (p: ProfitUnit, type: UnitCostType, flat: number | null) =>
    (m: number): ProfitCell => {
      if (!inRange(m)) return null;
      const v = actualFor(p, type)?.[m];
      if (v !== undefined) return { value: v, estimated: false };
      return flatMonthly(p, flat)(m);
    };

  // Lumpy yearly charges: once any actual row exists for the year, only the
  // actual rows count; otherwise the yearly figure is spread evenly.
  const actualOrSpread =
    (p: ProfitUnit, type: UnitCostType, yearly: number | null) =>
    (m: number): ProfitCell => {
      if (!inRange(m)) return null;
      const arr = actualFor(p, type);
      if (arr && arr.some((v) => v !== undefined)) {
        const v = arr[m];
        return v === undefined ? null : { value: v, estimated: false };
      }
      return flatMonthly(p, yearly !== null ? Number(yearly) / 12 : null)(m);
    };

  const cellBuilders: Record<
    ProfitMetric,
    (p: ProfitUnit) => (m: number) => ProfitCell
  > = {
    collection: (p) => (m) =>
      !inRange(m)
        ? null
        : { value: collection.get(p.id)?.[m] ?? 0, estimated: false },
    rent_paid: (p) => actualOrFlat(p, "rent_paid", p.unit_rent),
    utilities: (p) => (m) => {
      if (!inRange(m) || !activeIn(p, m)) return null;
      const actual = utilityActual.get(p.id)?.[m];
      if (actual !== undefined) return { value: actual, estimated: false };
      const est = estimateFor(p, m);
      return est === null ? null : { value: est, estimated: true };
    },
    internet: (p) => actualOrFlat(p, "internet", p.internet_monthly),
    cleaning: (p) => actualOrFlat(p, "cleaning", p.cleaning_fee_monthly),
    amenity: (p) => actualOrSpread(p, "amenity", p.amenity_fees_yearly),
    misc: (p) => actualOrSpread(p, "misc", p.misc_fees_yearly),
    insurance: (p) => actualOrFlat(p, "insurance", p.insurance_monthly),
    profit: (p) => (m) => {
      if (!inRange(m)) return null;
      const active = activeIn(p, m);
      const revenue = collection.get(p.id)?.[m] ?? 0;
      if (!active && revenue === 0) return null;
      const costs: ProfitCell[] = EXPENSE_METRICS.map((e) =>
        cellBuilders[e.key](p)(m),
      );
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

  const cellFor = (metric: ProfitMetric, p: ProfitUnit) => cellBuilders[metric](p);

  const monthlyTotalOf = (metric: ProfitMetric): (number | null)[] =>
    PROFIT_MONTHS.map((_, m) => {
      if (!inRange(m)) return null;
      let sum = 0;
      for (const p of units) {
        const c = cellBuilders[metric](p)(m);
        if (c) sum += c.value;
      }
      return sum;
    });

  const yearlyOf = (arr: (number | null)[]) =>
    arr.reduce<number>((s, v) => s + (v ?? 0), 0);

  const monthlyRevenue = monthlyTotalOf("collection");
  const companyMonthly: (number | null)[] = PROFIT_MONTHS.map((_, m) =>
    inRange(m) ? companyMonthlyRaw[m] : null,
  );
  const expenseSeries: ProfitabilityData["summary"]["expenseSeries"] = [
    ...EXPENSE_METRICS.map((e) => {
      const monthly = monthlyTotalOf(e.key);
      return { ...e, monthly, yearly: yearlyOf(monthly) };
    }),
    {
      key: "company" as const,
      label: "Company costs",
      monthly: companyMonthly,
      yearly: yearlyOf(companyMonthly),
    },
  ];
  const companyItems: CompanyCostItem[] = [...companyByLabel]
    .map(([label, yearly]) => ({ label, yearly }))
    .sort((a, b) => b.yearly - a.yearly);
  const monthlyExpenses: (number | null)[] = PROFIT_MONTHS.map((_, m) =>
    !inRange(m)
      ? null
      : expenseSeries.reduce((s, e) => s + (e.monthly[m] ?? 0), 0),
  );
  const monthlyNet: (number | null)[] = PROFIT_MONTHS.map((_, m) =>
    monthlyRevenue[m] === null
      ? null
      : (monthlyRevenue[m] ?? 0) - (monthlyExpenses[m] ?? 0),
  );

  const revenueItems = lineItems.filter((i) => i.side === "revenue");
  const expenseItems = lineItems.filter((i) => i.side === "expense");
  const unitRevenueYear = yearlyOf(monthlyRevenue);
  const totalRevenue =
    unitRevenueYear + revenueItems.reduce((s, i) => s + Number(i.amount), 0);
  const totalExpenses =
    expenseSeries.reduce((s, e) => s + e.yearly, 0) +
    expenseItems.reduce((s, i) => s + Number(i.amount), 0);

  return {
    year,
    firstMonthIdx,
    lastMonthIdx,
    units,
    lineItems,
    cellFor,
    monthlyTotalOf,
    summary: {
      monthlyRevenue,
      monthlyExpenses,
      monthlyNet,
      expenseSeries,
      companyItems,
      unitRevenueYear,
      revenueItems,
      expenseItems,
      totalRevenue,
      totalExpenses,
      netTotal: totalRevenue - totalExpenses,
    },
  };
}
