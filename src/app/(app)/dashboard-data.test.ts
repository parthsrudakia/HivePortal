import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentRentCycle } from "@/lib/date";
import { LedgerDataError } from "@/lib/rent-data";
import { cappedClient } from "@/lib/testing/capped-table";

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getCachedClient: async () => mocks.client }));

import { getPaymentsThisCycle } from "./dashboard-data";

// 1,500 rent payments of $10 this rent cycle: past the 1,000-row cap.
const payments = Array.from({ length: 1_500 }, () => ({
  tenancy_id: "t1",
  amount: 10,
  paid_on: currentRentCycle().start,
  payment_type: "rent",
}));

beforeEach(() => {
  mocks.client = cappedClient({ payments });
});

describe("dashboard payments past the 1,000-row cap", () => {
  it("groups and counts every payment", async () => {
    const { paymentsByTenancy, collectedThisMonth } = await getPaymentsThisCycle();
    expect(paymentsByTenancy.get("t1")).toHaveLength(1_500);
    expect(collectedThisMonth).toBe(15_000);
  });

  it("fails loudly instead of showing $0 collected when payments can't be read", async () => {
    mocks.client = cappedClient({ payments }, (name) => name === "payments");
    await expect(getPaymentsThisCycle()).rejects.toBeInstanceOf(LedgerDataError);
  });
});
