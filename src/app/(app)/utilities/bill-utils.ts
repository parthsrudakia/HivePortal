// View helpers for the Utilities feature (log + chart). The shared bill
// types and math live in @/lib/utility-bills so the Telegram bot can use
// them too; re-exported here so feature imports stay local.

import {
  type BillRow,
  isOverThreshold,
} from "@/lib/utility-bills";

export {
  billMonth,
  monthLabel,
  monthLabelShort,
  usageTotal,
  isOverThreshold,
  OVERAGE_THRESHOLD,
} from "@/lib/utility-bills";
export type { BillRow } from "@/lib/utility-bills";

export type UnitOpt = { id: string; label: string };

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

/** Apply the log's filters (unit + over-$200 + charged-to-tenants) to the
 *  bill list. */
export function filterBills(
  bills: BillRow[],
  filter: string,
  overOnly: boolean,
  chargedOnly = false,
): BillRow[] {
  return bills.filter((b) => {
    if (overOnly && !isOverThreshold(b)) return false;
    if (chargedOnly && !b.overage_charged_at) return false;
    if (!filter) return true;
    return filter === "unmatched" ? !b.property_id : b.property_id === filter;
  });
}
