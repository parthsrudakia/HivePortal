import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  etToUtc,
  nextRun,
  parseSchedule,
  type Schedule,
} from "./schedule";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("etToUtc", () => {
  it("uses EST (UTC-5) in winter and EDT (UTC-4) in summer", () => {
    expect(iso(etToUtc("2026-12-01", "09:00"))).toBe("2026-12-01T14:00:00.000Z");
    expect(iso(etToUtc("2026-07-01", "09:00"))).toBe("2026-07-01T13:00:00.000Z");
  });

  it("is right on the days the clocks change", () => {
    // Fall back (Nov 1 2026): 09:00 is already EST.
    expect(iso(etToUtc("2026-11-01", "09:00"))).toBe("2026-11-01T14:00:00.000Z");
    // Spring forward (Mar 14 2027): 09:00 is already EDT.
    expect(iso(etToUtc("2027-03-14", "09:00"))).toBe("2027-03-14T13:00:00.000Z");
  });
});

describe("nextRun", () => {
  // Fri Nov 13 2026, 10:00 ET.
  const now = new Date("2026-11-13T15:00:00.000Z");

  it("daily: later today if the time is still ahead, else tomorrow", () => {
    expect(iso(nextRun({ kind: "daily", time: "17:30" }, now))).toBe(
      "2026-11-13T22:30:00.000Z",
    );
    expect(iso(nextRun({ kind: "daily", time: "09:00" }, now))).toBe(
      "2026-11-14T14:00:00.000Z",
    );
  });

  it("never returns the instant it was asked about", () => {
    const s: Schedule = { kind: "daily", time: "10:00" };
    expect(iso(nextRun(s, now))).toBe("2026-11-14T15:00:00.000Z");
  });

  it("weekly: picks the next listed weekday", () => {
    // Mondays + Thursdays → Monday Nov 16.
    expect(iso(nextRun({ kind: "weekly", time: "10:00", days: [1, 4] }, now))).toBe(
      "2026-11-16T15:00:00.000Z",
    );
  });

  it("monthly: the 31st falls back to the last day of a short month", () => {
    expect(
      iso(nextRun({ kind: "monthly", time: "09:00", day_of_month: 31 }, now)),
    ).toBe("2026-11-30T14:00:00.000Z");
  });

  it("interval: counts from the start date", () => {
    const s: Schedule = {
      kind: "interval",
      time: "09:00",
      every_days: 14,
      start_date: "2026-11-02",
    };
    expect(iso(nextRun(s, now))).toBe("2026-11-16T14:00:00.000Z");
    // A start date in the future is the first firing.
    expect(iso(nextRun({ ...s, start_date: "2026-12-07" }, now))).toBe(
      "2026-12-07T14:00:00.000Z",
    );
  });

  it("once: fires once, then never", () => {
    const s: Schedule = { kind: "once", date: "2026-11-20", time: "12:00" };
    expect(iso(nextRun(s, now))).toBe("2026-11-20T17:00:00.000Z");
    expect(nextRun(s, new Date("2026-11-20T17:00:00.000Z"))).toBeNull();
  });

  it("keeps the same wall-clock time across a DST change", () => {
    const before = new Date("2027-03-13T15:00:00.000Z"); // Sat 10:00 EST
    expect(iso(nextRun({ kind: "daily", time: "09:00" }, before))).toBe(
      "2027-03-14T13:00:00.000Z", // 09:00 EDT
    );
  });
});

describe("parseSchedule", () => {
  it("rejects bad times, dates and weekdays", () => {
    expect(parseSchedule({ kind: "daily", time: "9am" }, "2026-11-13").ok).toBe(false);
    expect(
      parseSchedule({ kind: "once", time: "09:00", date: "2026-02-30" }, "2026-11-13").ok,
    ).toBe(false);
    expect(
      parseSchedule({ kind: "weekly", time: "09:00", days: [7] }, "2026-11-13").ok,
    ).toBe(false);
    expect(parseSchedule({ kind: "weekly", time: "09:00" }, "2026-11-13").ok).toBe(false);
  });

  it("normalizes weekdays and defaults an interval's start to today", () => {
    expect(
      parseSchedule({ kind: "weekly", time: "09:00", days: [4, 1, 4] }, "2026-11-13"),
    ).toEqual({ ok: true, schedule: { kind: "weekly", time: "09:00", days: [1, 4] } });
    expect(
      parseSchedule({ kind: "interval", time: "09:00", every_days: 3 }, "2026-11-13"),
    ).toEqual({
      ok: true,
      schedule: { kind: "interval", time: "09:00", every_days: 3, start_date: "2026-11-13" },
    });
  });
});

describe("describeSchedule", () => {
  it("reads naturally", () => {
    expect(describeSchedule({ kind: "weekly", time: "10:00", days: [1, 4] })).toBe(
      "Every Mon, Thu at 10:00 AM ET",
    );
    expect(describeSchedule({ kind: "monthly", time: "17:30", day_of_month: 22 })).toBe(
      "Monthly on the 22nd at 5:30 PM ET",
    );
    expect(describeSchedule({ kind: "daily", time: "00:05" })).toBe(
      "Every day at 12:05 AM ET",
    );
  });
});
