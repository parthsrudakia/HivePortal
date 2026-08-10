import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import {
  loadProfitability,
  profitUnitLabel,
  PROFIT_MONTHS,
} from "@/lib/profitability";
import { admin } from "./helpers";

// ----- Profitability (owner-only surface — bot access is already limited
// to the operators via ALLOWED_TELEGRAM_USER_IDS) -----

export async function getProfitability(args: { year?: number }) {
  const supabase = admin();
  const today = todayISO();
  const year = args.year ?? Number(today.slice(0, 4));
  if (year < 2020 || year > 2100) throw new Error("Invalid year.");

  const data = await loadProfitability(supabase, year, today);
  const round = (n: number) => Math.round(n * 100) / 100;
  const monthsWithData = PROFIT_MONTHS.slice(
    0,
    Math.max(0, data.lastMonthIdx + 1),
  );

  const units = data.units
    .map((p) => {
      const profitCells = PROFIT_MONTHS.map((_, m) =>
        data.cellFor("profit", p)(m),
      );
      const present = profitCells.filter((c) => c !== null);
      const revenueCells = PROFIT_MONTHS.map((_, m) =>
        data.cellFor("collection", p)(m),
      );
      return {
        unit: profitUnitLabel(p),
        property_id: p.id,
        profit_ytd: round(present.reduce((s, c) => s + (c?.value ?? 0), 0)),
        revenue_ytd: round(
          revenueCells.reduce((s, c) => s + (c?.value ?? 0), 0),
        ),
        includes_estimated_utilities: present.some((c) => c?.estimated),
        monthly_profit: Object.fromEntries(
          profitCells
            .map((c, m) => [PROFIT_MONTHS[m], c ? round(c.value) : null])
            .filter(([, v]) => v !== null),
        ),
      };
    })
    .sort((a, b) => a.profit_ytd - b.profit_ytd);

  const s = data.summary;
  return {
    year,
    months_with_data: monthsWithData,
    units,
    summary: {
      total_revenue: round(s.totalRevenue),
      total_expenses: round(s.totalExpenses),
      net_profit: round(s.netTotal),
      revenue: {
        rent_collection_units: round(s.unitRevenueYear),
        line_items: s.revenueItems.map((i) => ({
          id: i.id,
          label: i.label,
          amount: round(Number(i.amount)),
        })),
      },
      expenses: {
        by_category: s.expenseSeries.map((e) => ({
          category: e.label,
          yearly: round(e.yearly),
        })),
        line_items: s.expenseItems.map((i) => ({
          id: i.id,
          label: i.label,
          amount: round(Number(i.amount)),
        })),
      },
      monthly_net: Object.fromEntries(
        s.monthlyNet
          .map((v, m) => [PROFIT_MONTHS[m], v === null ? null : round(v)])
          .filter(([, v]) => v !== null),
      ),
    },
    notes:
      "Rent collection = payments dated in the calendar month (deposits excluded, refunds subtracted). Utility months without a bill use same-bedroom averages (includes_estimated_utilities). Line items are manual yearly amounts and count in the totals but not in monthly figures.",
  };
}

export async function addProfitabilityLineItem(args: {
  year: number;
  side: "revenue" | "expense";
  label: string;
  amount: number;
}) {
  if (!Number.isInteger(args.year) || args.year < 2020 || args.year > 2100)
    throw new Error("Invalid year.");
  if (!args.label.trim()) throw new Error("Give the line item a name.");
  if (!Number.isFinite(args.amount) || args.amount <= 0)
    throw new Error("Amount must be a positive number.");

  const supabase = admin();
  const { data, error } = await supabase
    .from("profitability_line_items")
    .insert({
      year: args.year,
      side: args.side,
      label: args.label.trim(),
      amount: args.amount,
      created_by: "telegram",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return {
    ok: true,
    id: data.id,
    added: `${args.side} "${args.label.trim()}" $${args.amount.toLocaleString()} (${args.year})`,
  };
}

export const analyticsTools = [
  betaZodTool({
    name: "get_profitability",
    description:
      "Unit profitability for a year (defaults to the current year): per-unit " +
      "YTD and monthly profit (revenue collected minus rent paid, utilities, " +
      "internet, cleaning, amenity, misc, insurance), plus the year summary " +
      "with total revenue / expenses / net and the manual revenue/expense line " +
      "items. Units sorted worst profit first. Utility months without an " +
      "uploaded bill use same-bedroom-unit averages (flagged as estimated). " +
      "Matches the portal's Profitability tab exactly.",
    inputSchema: z.object({
      year: z.number().int().optional().describe("Defaults to the current year"),
    }),
    run: async (args) => JSON.stringify(await getProfitability(args)),
  }),
  betaZodTool({
    name: "add_profitability_line_item",
    description:
      "Add a manual yearly revenue or expense line item to the Profitability " +
      "summary (e.g. admin costs, insurance payout). Counts toward that " +
      "year's totals and net profit.",
    inputSchema: z.object({
      year: z.number().int(),
      side: z.enum(["revenue", "expense"]),
      label: z.string().describe('e.g. "Admin costs — Upwork"'),
      amount: z.number().positive().describe("Yearly amount in dollars"),
    }),
    run: async (args) => JSON.stringify(await addProfitabilityLineItem(args)),
  }),
  betaZodTool({
    name: "get_collection_summary",
    description:
      "Headline rent-collection KPIs: this-month expected/collected/outstanding, " +
      "year-to-date expected/collected, and lifetime collected + payment count.",
    inputSchema: z.object({}),
    run: async () => {
      const { getCollectionSummary } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(await getCollectionSummary());
    },
  }),
  betaZodTool({
    name: "get_monthly_collections",
    description:
      "Per-month timeline of expected vs collected rent across the portfolio. " +
      "Defaults to all months from the earliest tenancy start through the current month.",
    inputSchema: z.object({
      from_month: z
        .string()
        .optional()
        .describe('Start month "YYYY-MM"; defaults to earliest tenancy start'),
      to_month: z
        .string()
        .optional()
        .describe('End month "YYYY-MM"; defaults to current month'),
    }),
    run: async (args) => {
      const { getMonthlyCollections } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(
        await getMonthlyCollections(args.from_month, args.to_month),
      );
    },
  }),
  betaZodTool({
    name: "get_property_collections",
    description:
      "Lifetime rent collected per property, sorted descending. " +
      "Optionally bounded by date range (paid_on between from and to).",
    inputSchema: z.object({
      from: z.string().optional().describe('Start date "YYYY-MM-DD" (optional)'),
      to: z.string().optional().describe('End date "YYYY-MM-DD" (optional)'),
    }),
    run: async (args) => {
      const { getPropertyCollections } = await import(
        "@/lib/analytics/collections"
      );
      return JSON.stringify(await getPropertyCollections(args.from, args.to));
    },
  }),
];
