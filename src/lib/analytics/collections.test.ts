import { beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerDataError } from "@/lib/rent-data";
import { cappedClient } from "@/lib/testing/capped-table";

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.client }));

import { getCollectionSummary, getPropertyCollections } from "@/lib/analytics/collections";

// 1,500 July rent payments of $10 on one unit: past the 1,000-row cap.
const payments = Array.from({ length: 1_500 }, () => ({
  amount: 10,
  paid_on: "2026-07-03",
  payment_type: "rent",
  tenancies: {
    rooms: {
      properties: { id: "p1", building_name: "Test House", street_address: "1 Main St", unit_number: "1" },
    },
  },
}));
const tables = {
  payments,
  rooms: [{ id: "r1" }],
  tenancies: [
    { id: "t1", start_date: "2026-06-01", move_out_date: null, paused_at: null, monthly_rent: 1_000, first_month_rent: null },
  ],
};

beforeEach(() => {
  mocks.client = cappedClient(tables);
});

describe("collections analytics past the 1,000-row cap", () => {
  it("counts every payment across all properties", async () => {
    const { lifetime } = await getCollectionSummary();
    expect(lifetime).toEqual({ collected: 15_000, payment_count: 1_500 });
  });

  it("counts every payment for a property filter", async () => {
    const { lifetime } = await getCollectionSummary(["p1"]);
    expect(lifetime).toEqual({ collected: 15_000, payment_count: 1_500 });
  });

  it("counts every payment per property", async () => {
    const rows = await getPropertyCollections("2026-01-01", "2026-12-31");
    expect(rows).toEqual([expect.objectContaining({ property_id: "p1", collected: 15_000 })]);
  });

  it("fails loudly instead of reporting nothing collected when payments can't be read", async () => {
    mocks.client = cappedClient(tables, (name) => name === "payments");
    await expect(getCollectionSummary()).rejects.toBeInstanceOf(LedgerDataError);
    await expect(getPropertyCollections()).rejects.toBeInstanceOf(LedgerDataError);
  });
});
