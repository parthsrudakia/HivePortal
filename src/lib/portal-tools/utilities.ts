import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  billMonth,
  isOverThreshold,
  usageTotal,
  OVERAGE_THRESHOLD,
  monthLabel as utilityMonthLabel,
  type BillRow,
} from "@/lib/utility-bills";
import { admin, one, propertyLabel } from "./helpers";

const CREDENTIAL_CATEGORIES = [
  "payment_portal",
  "maintenance_portal",
  "utility",
  "internet",
  "building_login",
  "other",
] as const;
type CredentialCategory = (typeof CREDENTIAL_CATEGORIES)[number];

export async function getCredentials(args: {
  property_id?: string;
  category?: CredentialCategory;
}) {
  const supabase = admin();
  let q = supabase
    .from("credentials")
    .select(
      `id, category, service_name, property_id, username,
       login_url, account_number, owner_label, notes,
       properties(building_name, street_address, unit_number)`,
    )
    .order("service_name");
  if (args.property_id) q = q.eq("property_id", args.property_id);
  if (args.category) q = q.eq("category", args.category);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  // Passwords are encrypted at rest; decrypt on demand via the service-role
  // function (the bot uses the service role, which is authorized for it).
  return Promise.all(
    (data ?? []).map(async (c) => {
      const { data: pw } = await supabase.rpc("credential_password_internal", {
        cred_id: c.id,
      });
      return {
        id: c.id,
        category: c.category,
        service_name: c.service_name,
        property: c.properties ? propertyLabel(one(c.properties)!) : null,
        username: c.username,
        password: pw ?? null,
        login_url: c.login_url,
        account_number: c.account_number,
        owner_label: c.owner_label,
        notes: c.notes,
      };
    }),
  );
}

type UtilityType = "electric" | "gas" | "water" | "internet" | "trash" | "other";

export async function getUtilityBills(args: {
  month?: string;
  property_id?: string;
  utility_type?: UtilityType;
  over_threshold_only?: boolean;
  months_back?: number;
}) {
  const supabase = admin();

  if (args.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) {
    throw new Error('month must be "YYYY-MM".');
  }

  const { data, error } = await supabase
    .from("utility_bills")
    .select(
      `id, property_id, provider, utility_type, statement_date,
       period_start, period_end, total_amount, overage_dismissed, notes,
       created_at,
       utility_bill_charges(id, kind, description, amount),
       properties(building_name, street_address, unit_number)`,
    )
    .order("statement_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  // A bill's month is where the majority of its billing period falls, so
  // month filtering happens here rather than in SQL.
  const rows = ((data ?? []) as (BillRow & {
    properties: {
      building_name: string | null;
      street_address: string;
      unit_number: string;
    } | null;
  })[]).map((b) => ({ bill: b, month: billMonth(b) }));

  // Default window when no single month is requested, so the payload (and
  // the model's context) stays bounded.
  const monthsBack = args.months_back ?? 6;
  // Month arithmetic on a year*12+month index — setUTCMonth on a day-29..31
  // date overflows into the next month and silently drops the oldest month.
  const now = new Date();
  const cutoffIdx =
    now.getUTCFullYear() * 12 + now.getUTCMonth() - (monthsBack - 1);
  const cutoffYm = `${Math.floor(cutoffIdx / 12)}-${String((cutoffIdx % 12) + 1).padStart(2, "0")}`;

  const filtered = rows.filter(({ bill, month }) => {
    if (args.month ? month !== args.month : month < cutoffYm) return false;
    if (args.property_id === "unmatched") {
      if (bill.property_id) return false;
    } else if (args.property_id && bill.property_id !== args.property_id) {
      return false;
    }
    if (args.utility_type && bill.utility_type !== args.utility_type)
      return false;
    if (args.over_threshold_only && !isOverThreshold(bill)) return false;
    return true;
  });

  const monthly = new Map<string, { total: number; count: number }>();
  for (const { bill, month } of filtered) {
    const m = monthly.get(month) ?? { total: 0, count: 0 };
    m.total += Number(bill.total_amount);
    m.count += 1;
    monthly.set(month, m);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    window: args.month
      ? utilityMonthLabel(args.month)
      : `last ${monthsBack} months`,
    bill_count: filtered.length,
    total_amount: round(
      filtered.reduce((s, { bill }) => s + Number(bill.total_amount), 0),
    ),
    monthly_totals: [...monthly.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([ym, m]) => ({
        month: ym,
        label: utilityMonthLabel(ym),
        bill_count: m.count,
        total: round(m.total),
      })),
    bills: filtered.map(({ bill, month }) => {
      const usage = usageTotal(bill);
      const over = isOverThreshold(bill);
      return {
        id: bill.id,
        unit: bill.properties ? propertyLabel(one(bill.properties)!) : "unmatched",
        provider: bill.provider,
        utility_type: bill.utility_type,
        month,
        statement_date: bill.statement_date,
        period: `${bill.period_start ?? "?"} → ${bill.period_end ?? "?"}`,
        total_amount: round(Number(bill.total_amount)),
        usage_total: round(usage),
        late_fees_and_other: round(Number(bill.total_amount) - usage),
        over_200_usage_threshold: over,
        excess_over_200: over ? round(usage - OVERAGE_THRESHOLD) : 0,
        overage_dismissed: bill.overage_dismissed,
        notes: bill.notes,
      };
    }),
  };
}

/** Signed link to a utility bill's original statement (private bucket). */
export async function getUtilityStatementUrl(args: { bill_id: string }) {
  const supabase = admin();
  const { data: bill, error } = await supabase
    .from("utility_bills")
    .select("statement_path, provider, utility_type")
    .eq("id", args.bill_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!bill) throw new Error("Bill not found.");
  if (!bill.statement_path) throw new Error("No statement file on this bill.");

  const { data: signed, error: signErr } = await supabase.storage
    .from("utilities")
    .createSignedUrl(bill.statement_path, 3600);
  if (signErr || !signed?.signedUrl) {
    throw new Error(signErr?.message ?? "Failed to sign the statement URL.");
  }
  return {
    url: signed.signedUrl,
    expires_in: "1 hour",
    provider: bill.provider,
    utility_type: bill.utility_type,
  };
}

export const utilitiesTools = [
  betaZodTool({
    name: "get_utility_bills",
    description:
      "Utility bills logged in the portal (extracted from uploaded statements), " +
      "with per-month totals. A bill belongs to the calendar month holding the " +
      "majority of its billing-period days (Apr 7–May 6 → April). Defaults to " +
      "the last 6 months; pass month for a single month. Lease clause: when a " +
      "unit's electric or gas usage charges exceed $200 in a month, the excess " +
      "is split among the occupants — over_200_usage_threshold / excess_over_200 " +
      "flag those bills (late fees don't count toward the $200). Bills the " +
      "extractor couldn't match to a unit have unit: 'unmatched'.",
    inputSchema: z.object({
      month: z
        .string()
        .optional()
        .describe('Single month as "YYYY-MM". Omit for the recent window.'),
      property_id: z
        .string()
        .optional()
        .describe(
          'Filter to one unit (UUID from list_properties), or "unmatched" ' +
            "for bills not linked to a unit.",
        ),
      utility_type: z
        .enum(["electric", "gas", "water", "internet", "trash", "other"])
        .optional(),
      over_threshold_only: z
        .boolean()
        .optional()
        .describe("Only electric/gas bills whose usage exceeds $200."),
      months_back: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe("Window size when month is omitted (default 6)."),
    }),
    run: async (args) => JSON.stringify(await getUtilityBills(args)),
  }),
  betaZodTool({
    name: "get_utility_statement_url",
    description:
      "Get a temporary (1-hour) link to a utility bill's original uploaded " +
      "statement (PDF/photo). Find the bill_id via get_utility_bills.",
    inputSchema: z.object({
      bill_id: z.string().describe("UUID of the bill from get_utility_bills"),
    }),
    run: async (args) => JSON.stringify(await getUtilityStatementUrl(args)),
  }),
  betaZodTool({
    name: "get_credentials",
    description:
      "Fetch credentials filtered by property and/or category. " +
      "Categories: payment_portal, maintenance_portal, utility, internet, " +
      "building_login, other.",
    inputSchema: z.object({
      property_id: z.string().optional(),
      category: z.enum(CREDENTIAL_CATEGORIES).optional(),
    }),
    run: async (args) =>
      JSON.stringify(
        await getCredentials({
          property_id: args.property_id,
          category: args.category,
        }),
      ),
  }),
];
