// Shared types and bill math for the Utilities feature (log + chart).

export type UnitOpt = { id: string; label: string };

export type BillRow = {
  id: string;
  property_id: string | null;
  provider: string | null;
  utility_type: string;
  account_number: string | null;
  service_address: string | null;
  statement_date: string | null;
  period_start: string | null;
  period_end: string | null;
  total_amount: number;
  overage_dismissed: boolean;
  notes: string | null;
  created_at: string;
  utility_bill_charges: {
    id: string;
    kind: "current" | "late_fee" | "other";
    description: string | null;
    amount: number;
  }[];
};

export const fmtMoney = (n: number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtDate = (iso: string | null) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

/**
 * The month a bill belongs to: the calendar month holding the majority of
 * the billing period's days (Apr 7 – May 6 → April). Ties go to the earlier
 * month. Falls back to the statement date, then the upload date.
 */
export function billMonth(b: BillRow): string {
  if (b.period_start && b.period_end && b.period_end >= b.period_start) {
    const days = new Map<string, number>();
    const d = new Date(`${b.period_start.slice(0, 10)}T12:00:00Z`);
    const end = new Date(`${b.period_end.slice(0, 10)}T12:00:00Z`);
    // Billing periods are ~1 month; walking the days is simple and exact.
    for (let i = 0; i < 400 && d <= end; i++) {
      const key = d.toISOString().slice(0, 7);
      days.set(key, (days.get(key) ?? 0) + 1);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    let best = "";
    let bestCount = -1;
    for (const [key, count] of days) {
      if (count > bestCount || (count === bestCount && key < best)) {
        best = key;
        bestCount = count;
      }
    }
    if (best) return best;
  }
  const anchor = b.period_start ?? b.statement_date ?? b.created_at;
  return anchor.slice(0, 7);
}

export const monthLabel = (ym: string) =>
  new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export const monthLabelShort = (ym: string) =>
  new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

// Lease clause: when a unit's electric/gas bill exceeds $200 in a month, the
// excess is split among the occupants. The test uses usage charges (kind
// 'current', which includes taxes) and ignores late fees ('late_fee'/'other').
export const OVERAGE_THRESHOLD = 200;

export function usageTotal(b: BillRow): number {
  return b.utility_bill_charges
    .filter((c) => c.kind === "current")
    .reduce((s, c) => s + Number(c.amount), 0);
}

export function isOverThreshold(b: BillRow): boolean {
  return (
    (b.utility_type === "electric" || b.utility_type === "gas") &&
    usageTotal(b) > OVERAGE_THRESHOLD
  );
}

/** Apply the log's filters (unit + over-$200) to the bill list. */
export function filterBills(
  bills: BillRow[],
  filter: string,
  overOnly: boolean,
): BillRow[] {
  return bills.filter((b) => {
    if (overOnly && !isOverThreshold(b)) return false;
    if (!filter) return true;
    return filter === "unmatched" ? !b.property_id : b.property_id === filter;
  });
}
