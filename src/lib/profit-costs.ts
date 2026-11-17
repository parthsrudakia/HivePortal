/**
 * Actual monthly costs for the Profitability tab (table `profit_costs`).
 *
 * A row is one cost line: a unit's rent paid, internet, cleaning, insurance,
 * amenity or misc charge for a month, or a company-wide cost (Upwork, admin)
 * with no unit. The costs agent sends them through POST
 * /api/profitability/costs; operators add company costs on /profitability.
 *
 * How the tab uses them (see profitability.ts):
 *   - rent paid / internet / cleaning / insurance: a month with actual rows
 *     shows their sum; a month without falls back to the unit's flat figure.
 *   - amenity / misc: once a unit has any actual rows of that type in the
 *     year, only the actual rows count (these charges are lumpy, so spreading
 *     the yearly figure on top would double count); otherwise yearly ÷ 12.
 *   - company: summed per month into the "Company costs" expense line.
 */

import { z } from "zod";
import { LedgerDataError } from "@/lib/rent-data";
import { zUuid } from "@/lib/validation";
import { matchUnitByAddress } from "@/lib/utility-verify";
import type { UnitOption } from "@/lib/utility-extract";

export const UNIT_COST_TYPES = [
  "rent_paid",
  "internet",
  "cleaning",
  "insurance",
  "amenity",
  "misc",
] as const;
export type UnitCostType = (typeof UNIT_COST_TYPES)[number];
export const COST_TYPES = [...UNIT_COST_TYPES, "company"] as const;
export type CostType = (typeof COST_TYPES)[number];

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Most cost lines one API call may carry. */
export const MAX_COSTS_PER_REQUEST = 500;

export type ProfitCostRow = {
  property_id: string | null;
  month: string; // YYYY-MM
  cost_type: CostType;
  amount: number | string;
  label: string | null;
};

// Works with both the cookie-session server client and the service-role
// client (same shape profitability.ts uses).
type Client = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
};

/** PostgREST / Postgres "table does not exist" (migration not applied yet). */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /relation .*profit_costs.* does not exist|could not find the table/i.test(
      error.message ?? "",
    )
  );
}

const PAGE = 1000;

/**
 * Every cost row for the year, paged past the 1,000-row response cap. A
 * missing table (code deployed before the migration ran) reads as no rows so
 * the tab keeps working on flat figures; any other failure throws rather
 * than under-report costs.
 */
export async function loadProfitCosts(
  supabase: Client,
  year: number,
): Promise<ProfitCostRow[]> {
  const out: ProfitCostRow[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += PAGE) {
    const { data, error, count } = await supabase
      .from("profit_costs")
      .select("property_id, month, cost_type, amount, label", { count: "exact" })
      .gte("month", `${year}-01`)
      .lte("month", `${year}-12`)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) {
      if (from === 0 && isMissingTable(error)) return [];
      throw new LedgerDataError("profit costs", error.message ?? "read failed");
    }
    if (expected === null) {
      if (count === null || count === undefined)
        throw new LedgerDataError("profit costs", "server returned no row count");
      expected = count;
    }
    const rows = (data ?? []) as ProfitCostRow[];
    out.push(...rows);
    if (out.length >= (expected ?? 0)) break;
    if (rows.length === 0)
      throw new LedgerDataError(
        "profit costs",
        `only ${out.length} of ${expected} rows were returned`,
      );
  }
  return out;
}

// ---------- API intake ----------

export const CostLineSchema = z
  .object({
    ref: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Stable id for this cost line; re-sending the same ref replaces it."),
    type: z.enum(COST_TYPES),
    month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
    amount: z
      .number()
      .finite()
      .refine((n) => Math.abs(n) < 1_000_000, "amount is out of range"),
    property_id: zUuid.nullish(),
    unit: z.string().trim().max(300).nullish(),
    label: z.string().trim().max(200).nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type CostLine = z.infer<typeof CostLineSchema>;

export const CostBatchSchema = z
  .object({
    costs: z.array(z.unknown()).min(1).max(MAX_COSTS_PER_REQUEST),
  })
  .strict();

export type CostResult = {
  ref: string | null;
  status: "saved" | "unmatched" | "invalid";
  property_id?: string | null;
  unit_label?: string | null;
  error?: string;
};

/**
 * Which unit a cost line is for: an explicit property_id that exists wins,
 * otherwise the `unit` address is matched the same way utility statements
 * are (street + unit number, one unambiguous hit). Company costs have none.
 */
export function resolveCostUnit(
  line: CostLine,
  units: UnitOption[],
): { propertyId: string | null; error?: string } {
  if (line.type === "company") {
    if (line.property_id || line.unit)
      return { propertyId: null, error: "company costs take no unit or property_id" };
    return { propertyId: null };
  }
  if (line.property_id) {
    return units.some((u) => u.id === line.property_id)
      ? { propertyId: line.property_id }
      : { propertyId: null, error: "property_id is not a known unit" };
  }
  if (!line.unit) return { propertyId: null, error: "unit or property_id is required" };
  const id = matchUnitByAddress(line.unit, units);
  return id
    ? { propertyId: id }
    : { propertyId: null, error: "no single unit matches this address" };
}
