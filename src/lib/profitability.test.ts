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
