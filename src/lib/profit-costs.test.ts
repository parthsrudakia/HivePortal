import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upserts: [] as { rows: unknown[]; opts: unknown }[],
  upsertError: null as null | { message: string },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/utility-ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utility-ingest")>()),
  loadUnits: async () => [
    { id: "11111111-1111-4111-8111-111111111111", label: "Sample Tower Apt 3B", street_address: "100 Sample St", unit_number: "3B" },
    { id: "22222222-2222-4222-8222-222222222222", label: "200 Example Ave Apt 12", street_address: "200 Example Ave", unit_number: "12" },
  ],
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      upsert: async (rows: unknown[], opts: unknown) => {
        mocks.upserts.push({ rows, opts });
        return { error: mocks.upsertError };
      },
    }),
  }),
}));

import { POST } from "@/app/api/profitability/costs/route";
import { CostLineSchema, resolveCostUnit } from "@/lib/profit-costs";

const KEY = "test-key";
const post = (body: unknown, auth = `Bearer ${KEY}`) =>
  POST(
    new Request("https://portal.test/api/profitability/costs", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/profitability/costs", () => {
  beforeEach(() => {
    process.env.PROFIT_COSTS_API_KEY = KEY;
    mocks.upserts = [];
    mocks.upsertError = null;
  });

  it("rejects a wrong token", async () => {
    const res = await post({ costs: [] }, "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("saves lines by address or property_id, upserting on source + ref", async () => {
    const res = await post({
      costs: [
        { ref: "clickpay:3b:2026-10:amenity", type: "amenity", month: "2026-10", amount: 45.004, unit: "100 Sample St Apt 3B, New York NY", label: "Amenity fee" },
        { ref: "r2", type: "rent_paid", month: "2026-10", amount: 3150, property_id: "22222222-2222-4222-8222-222222222222" },
        { ref: "upwork:2026-10", type: "company", month: "2026-10", amount: 450, label: "Upwork" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ saved: 3, unmatched: 0, invalid: 0 });
    expect(body.results[0]).toMatchObject({ status: "saved", unit_label: "Sample Tower Apt 3B" });
    expect(mocks.upserts).toHaveLength(1);
    expect(mocks.upserts[0].opts).toEqual({ onConflict: "source,ref" });
    expect(mocks.upserts[0].rows).toMatchObject([
      { property_id: "11111111-1111-4111-8111-111111111111", cost_type: "amenity", amount: 45, source: "agent" },
      { property_id: "22222222-2222-4222-8222-222222222222", cost_type: "rent_paid", amount: 3150 },
      { property_id: null, cost_type: "company", label: "Upwork" },
    ]);
  });

  it("reports unmatched, invalid and duplicate lines without saving them", async () => {
    const res = await post({
      costs: [
        { ref: "a", type: "amenity", month: "2026-10", amount: 10, unit: "999 Nowhere Rd Apt 1" },
        { ref: "b", type: "amenity", month: "2026-13", amount: 10, unit: "100 Sample St Apt 3B" },
        { ref: "c", type: "company", month: "2026-10", amount: 10, unit: "100 Sample St Apt 3B" },
        { ref: "d", type: "misc", month: "2026-10", amount: 5, unit: "100 Sample St Apt 3B" },
        { ref: "d", type: "misc", month: "2026-10", amount: 6, unit: "100 Sample St Apt 3B" },
      ],
    });
    const body = await res.json();
    expect(body).toMatchObject({ saved: 1, unmatched: 1, invalid: 3 });
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      "unmatched",
      "invalid",
      "invalid",
      "saved",
      "invalid",
    ]);
    expect(mocks.upserts[0].rows).toHaveLength(1);
  });

  it("rejects a body that isn't a batch", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ costs: [] })).status).toBe(400);
    expect((await post({ lines: [{}] })).status).toBe(400);
  });

  it("surfaces a database failure instead of claiming success", async () => {
    mocks.upsertError = { message: "boom" };
    const res = await post({
      costs: [{ ref: "x", type: "company", month: "2026-10", amount: 1 }],
    });
    expect(res.status).toBe(500);
  });
});

describe("resolveCostUnit", () => {
  const units = [
    { id: "u1", label: "A Apt 1", street_address: "1 Main St", unit_number: "1" },
  ];
  const line = (over: object) =>
    CostLineSchema.parse({ ref: "r", type: "amenity", month: "2026-10", amount: 1, ...over });

  it("needs a unit for unit costs", () => {
    expect(resolveCostUnit(line({}), units).error).toMatch(/required/);
  });

  it("matches an address with the unit number", () => {
    expect(resolveCostUnit(line({ unit: "1 Main St Apt 1" }), units)).toEqual({ propertyId: "u1" });
  });
});
