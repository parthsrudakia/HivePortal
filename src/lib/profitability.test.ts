import { describe, expect, it } from "vitest";
import { LedgerDataError } from "@/lib/rent-data";
import { loadProfitability, type ProfitUnit } from "@/lib/profitability";
import { ROW_CAP, cappedClient } from "@/lib/testing/capped-table";

const unit: ProfitUnit = {
  id: "p1",
  building_name: "Test House",
  street_address: "1 Main St",
  unit_number: "1",
  bedrooms: 2,
  unit_rent: null,
  unit_lease_start: null,
  unit_lease_end: null,
  amenity_fees_yearly: null,
  misc_fees_yearly: null,
  internet_monthly: null,
  cleaning_fee_monthly: null,
  insurance_monthly: null,
};

// 1,500 July payments of $10 and 1,200 August bills of $1: both past the cap.
const payments = Array.from({ length: 1_500 }, () => ({
  amount: 10,
  paid_on: "2026-07-03",
  payment_type: "rent",
  tenancies: { rooms: { property_id: "p1" } },
}));
const bills = Array.from({ length: 1_200 }, (_, i) => ({
  id: `b${i}`,
  property_id: "p1",
  provider: "Con Ed",
  utility_type: "electric",
  account_number: null,
  service_address: null,
  statement_date: null,
  period_start: "2026-08-01",
  period_end: "2026-08-31",
  total_amount: 1,
  overage_dismissed: false,
  overage_charged_at: null,
  notes: null,
  created_at: "2026-09-01T00:00:00Z",
  utility_bill_charges: [],
}));

const client = (fail?: (table: string) => boolean) =>
  cappedClient({ properties: [unit], payments, utility_bills: bills }, fail);

describe("loadProfitability past the 1,000-row cap", () => {
  it("one unpaged read only sees the first 1,000 rows (what the page used to get)", async () => {
    const { data } = await client().from("payments").select("amount");
    expect(data).toHaveLength(ROW_CAP);
  });

  it("counts every payment and every bill", async () => {
    const data = await loadProfitability(client(), 2026, "2026-11-03");
    const JUL = 6;
    const AUG = 7;
    expect(data.cellFor("collection", unit)(JUL)).toEqual({ value: 15_000, estimated: false });
    expect(data.cellFor("utilities", unit)(AUG)).toEqual({ value: 1_200, estimated: false });
    expect(data.summary.unitRevenueYear).toBe(15_000);
  });

  it("fails loudly instead of under-reporting when payments can't be read", async () => {
    await expect(
      loadProfitability(client((name) => name === "payments"), 2026, "2026-11-03"),
    ).rejects.toBeInstanceOf(LedgerDataError);
  });
});

describe("loadProfitability with actual monthly costs", () => {
  const flatUnit: ProfitUnit = {
    ...unit,
    id: "p2",
    unit_rent: 3_000,
    internet_monthly: 60,
    amenity_fees_yearly: 1_200,
  };
  const SEP = 8;
  const OCT = 9;
  const costs = [
    // October rent paid came in higher than the lease figure.
    { property_id: "p2", month: "2026-10", cost_type: "rent_paid", amount: 3_150, label: null },
    // Two amenity charges in September, none in other months.
    { property_id: "p2", month: "2026-09", cost_type: "amenity", amount: 75, label: "Gym" },
    { property_id: "p2", month: "2026-09", cost_type: "amenity", amount: 25, label: "Package room" },
    // Company costs, one of them in a month that hasn't happened yet.
    { property_id: null, month: "2026-09", cost_type: "company", amount: 400, label: "Upwork" },
    { property_id: null, month: "2026-10", cost_type: "company", amount: 450, label: "Upwork" },
    { property_id: null, month: "2026-10", cost_type: "company", amount: 30, label: null },
    { property_id: null, month: "2026-12", cost_type: "company", amount: 999, label: "Upwork" },
  ];
  const load = () =>
    loadProfitability(
      cappedClient({ properties: [flatUnit], payments: [], utility_bills: [], profit_costs: costs }),
      2026,
      "2026-11-17",
    );

  it("uses the recorded cost for a month and the flat figure otherwise", async () => {
    const data = await load();
    expect(data.cellFor("rent_paid", flatUnit)(OCT)).toEqual({ value: 3_150, estimated: false });
    expect(data.cellFor("rent_paid", flatUnit)(SEP)).toEqual({ value: 3_000, estimated: false });
    expect(data.cellFor("internet", flatUnit)(OCT)).toEqual({ value: 60, estimated: false });
  });

  it("counts only actual amenity charges once a unit has any for the year", async () => {
    const data = await load();
    expect(data.cellFor("amenity", flatUnit)(SEP)).toEqual({ value: 100, estimated: false });
    // No yearly ÷ 12 on top of the real charges.
    expect(data.cellFor("amenity", flatUnit)(OCT)).toBeNull();
  });

  it("adds company costs to expenses inside the data window only", async () => {
    const data = await load();
    const company = data.summary.expenseSeries.find((e) => e.key === "company");
    expect(company?.monthly[SEP]).toBe(400);
    expect(company?.monthly[OCT]).toBe(480);
    expect(company?.monthly[11]).toBeNull();
    expect(company?.yearly).toBe(880);
    expect(data.summary.companyItems).toEqual([
      { label: "Upwork", yearly: 850 },
      { label: "Other", yearly: 30 },
    ]);
    expect(data.summary.monthlyExpenses[OCT]).toBe(3_150 + 60 + 480);
    expect(data.summary.monthlyNet[OCT]).toBe(-(3_150 + 60 + 480));
  });

  it("falls back to flat figures when the costs table isn't there yet", async () => {
    const missing = cappedClient({ properties: [flatUnit], payments: [], utility_bills: [] });
    const orig = missing.from;
    missing.from = (name: string) =>
      name === "profit_costs"
        ? ({
            select: () => ({
              gte: () => ({
                lte: () => ({
                  order: () => ({
                    range: async () => ({
                      data: null,
                      count: null,
                      error: { code: "PGRST205", message: "Could not find the table 'public.profit_costs'" },
                    }),
                  }),
                }),
              }),
            }),
          } as unknown as ReturnType<typeof orig>)
        : orig(name);
    const data = await loadProfitability(missing, 2026, "2026-11-17");
    expect(data.cellFor("rent_paid", flatUnit)(OCT)).toEqual({ value: 3_000, estimated: false });
  });

  it("fails loudly when costs can't be read for another reason", async () => {
    await expect(
      loadProfitability(
        cappedClient(
          { properties: [flatUnit], payments: [], utility_bills: [], profit_costs: costs },
          (name) => name === "profit_costs",
        ),
        2026,
        "2026-11-17",
      ),
    ).rejects.toBeInstanceOf(LedgerDataError);
  });
});
