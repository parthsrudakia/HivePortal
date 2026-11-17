import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCleaningSchedule } from "@/lib/cleaning-reminders";

const TODAY = "2026-11-17";

type Rec = { property_id: string; cleaning_date: string; kind: string | null };

// Reads answer from fixed data; inserts are recorded.
function fakeSupabase(records: Rec[], excluded: { id: string }[] = []) {
  const inserted: unknown[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "or", "returns"]) q[m] = () => q;
    q.then = <R,>(resolve: (r: unknown) => R) => Promise.resolve(result).then(resolve);
    return q;
  };
  const supabase = {
    from(table: string) {
      if (table === "properties") return chain({ data: excluded, error: null });
      const q = chain({ data: records, error: null });
      q.insert = async (rows: unknown[]) => {
        inserted.push(...rows);
        return { error: null };
      };
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: supabase as any, inserted };
}

describe("runCleaningSchedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the 35-day cadence when a move-out cleaning is booked far ahead", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-10-20", kind: "regular" },
      { property_id: "u1", cleaning_date: "2027-02-01", kind: "move_out" },
    ]);
    const res = await runCleaningSchedule(supabase);
    expect(res.rolled).toBe(1);
    expect(inserted).toEqual([{ property_id: "u1", cleaning_date: "2026-11-24" }]);
  });

  it("lets a move-out close to the due date stand in for the regular cleaning", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-10-20", kind: "regular" },
      // Regular would be 11-24; the move-out on 11-28 is within 7 days of it.
      { property_id: "u1", cleaning_date: "2026-11-28", kind: "move_out" },
    ]);
    const res = await runCleaningSchedule(supabase);
    expect(res.rolled).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("lets a move-out before the due date stand in too", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-10-20", kind: "regular" },
      { property_id: "u1", cleaning_date: "2026-11-19", kind: "move_out" },
    ]);
    await runCleaningSchedule(supabase);
    expect(inserted).toEqual([]);
  });

  it("still books the regular cleaning when the move-out is 8+ days after it", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-10-20", kind: "regular" },
      { property_id: "u1", cleaning_date: "2026-12-02", kind: "move_out" },
    ]);
    await runCleaningSchedule(supabase);
    expect(inserted).toEqual([{ property_id: "u1", cleaning_date: "2026-11-24" }]);
  });

  it("does not add a cleaning when a regular one is already booked", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-10-20", kind: "regular" },
      { property_id: "u1", cleaning_date: "2026-11-24", kind: "regular" },
      { property_id: "u1", cleaning_date: "2027-02-01", kind: "move_out" },
    ]);
    const res = await runCleaningSchedule(supabase);
    expect(res.rolled).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("counts a past move-out cleaning as the unit's last cleaning", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-09-01", kind: "regular" },
      { property_id: "u1", cleaning_date: "2026-11-01", kind: "move_out" },
    ]);
    await runCleaningSchedule(supabase);
    expect(inserted).toEqual([{ property_id: "u1", cleaning_date: "2026-12-06" }]);
  });

  it("steps an overdue cadence forward to today or later", async () => {
    const { supabase, inserted } = fakeSupabase([
      { property_id: "u1", cleaning_date: "2026-08-01", kind: "regular" },
    ]);
    await runCleaningSchedule(supabase);
    // 08-01 +35 = 09-05, +35 = 10-10, +35 = 11-14 (past), +35 = 12-19
    expect(inserted).toEqual([{ property_id: "u1", cleaning_date: "2026-12-19" }]);
  });

  it("skips paused or archived units and units only holding a future move-out", async () => {
    const { supabase, inserted } = fakeSupabase(
      [
        { property_id: "paused", cleaning_date: "2026-10-01", kind: "regular" },
        { property_id: "moveout-only", cleaning_date: "2027-01-10", kind: "move_out" },
      ],
      [{ id: "paused" }],
    );
    const res = await runCleaningSchedule(supabase);
    expect(res.rolled).toBe(0);
    expect(inserted).toEqual([]);
  });
});
