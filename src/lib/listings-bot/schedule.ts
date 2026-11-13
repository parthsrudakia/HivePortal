/**
 * Reminder schedules for the listings bot. All times are Eastern wall-clock;
 * the math names the zone explicitly (via Intl) rather than relying on the
 * runtime TZ pin, so it is correct across DST and in tests. Pure.
 */

import { APP_TIME_ZONE, addDaysISO, isoDayOfWeek } from "@/lib/date";

export type Schedule =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; days: number[] } // 0 = Sunday … 6 = Saturday
  | { kind: "monthly"; time: string; day_of_month: number }
  | { kind: "interval"; time: string; every_days: number; start_date: string };

/** The loose shape the agent's tool call supplies. */
export type ScheduleInput = {
  kind: "once" | "daily" | "weekly" | "monthly" | "interval";
  time: string;
  date?: string;
  days?: number[];
  day_of_month?: number;
  every_days?: number;
  start_date?: string;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(iso: string | undefined): iso is string {
  if (!iso || !DATE_RE.test(iso)) return false;
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function parseSchedule(
  input: ScheduleInput,
  todayET: string,
): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  if (!TIME_RE.test(input.time ?? "")) {
    return { ok: false, error: 'time must be 24-hour "HH:MM" (Eastern)' };
  }
  const time = input.time;
  switch (input.kind) {
    case "once":
      if (!validDate(input.date)) {
        return { ok: false, error: 'once needs date as "YYYY-MM-DD"' };
      }
      return { ok: true, schedule: { kind: "once", date: input.date, time } };
    case "daily":
      return { ok: true, schedule: { kind: "daily", time } };
    case "weekly": {
      const days = [...new Set(input.days ?? [])].sort((a, b) => a - b);
      if (
        days.length === 0 ||
        days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
      ) {
        return {
          ok: false,
          error: "weekly needs days: one or more of 0 (Sun) … 6 (Sat)",
        };
      }
      return { ok: true, schedule: { kind: "weekly", time, days } };
    }
    case "monthly": {
      const dom = input.day_of_month;
      if (!Number.isInteger(dom) || dom! < 1 || dom! > 31) {
        return { ok: false, error: "monthly needs day_of_month 1–31" };
      }
      return {
        ok: true,
        schedule: { kind: "monthly", time, day_of_month: dom! },
      };
    }
    case "interval": {
      const n = input.every_days;
      if (!Number.isInteger(n) || n! < 1 || n! > 365) {
        return { ok: false, error: "interval needs every_days 1–365" };
      }
      if (input.start_date !== undefined && !validDate(input.start_date)) {
        return { ok: false, error: 'start_date must be "YYYY-MM-DD"' };
      }
      return {
        ok: true,
        schedule: {
          kind: "interval",
          time,
          every_days: n!,
          start_date: input.start_date ?? todayET,
        },
      };
    }
    default:
      return { ok: false, error: "unknown schedule kind" };
  }
}

/** Eastern calendar date ("YYYY-MM-DD") of an instant. */
export function etDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE }).format(
    at,
  );
}

/** Eastern wall-clock minus UTC, in ms, at the given instant. */
function etOffsetMs(ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const n = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    n("second"),
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The instant at which Eastern clocks read `isoDate` `HH:MM`. */
export function etToUtc(isoDate: string, time: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = etOffsetMs(wall);
  let t = wall - first;
  // Across a DST change the offset at the guess differs from the real one.
  const second = etOffsetMs(t);
  if (second !== first) t = wall - second;
  return new Date(t);
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) /
      86_400_000,
  );
}

function matchesDay(s: Exclude<Schedule, { kind: "once" }>, iso: string) {
  switch (s.kind) {
    case "daily":
      return true;
    case "weekly":
      return s.days.includes(isoDayOfWeek(iso));
    case "monthly": {
      const [y, m, d] = iso.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      // "The 31st" fires on the last day of shorter months.
      return d === Math.min(s.day_of_month, lastDay);
    }
    case "interval": {
      const gap = daysBetween(s.start_date, iso);
      return gap >= 0 && gap % s.every_days === 0;
    }
  }
}

/** First firing strictly after `after`, or null when there is none. */
export function nextRun(s: Schedule, after: Date): Date | null {
  if (s.kind === "once") {
    const at = etToUtc(s.date, s.time);
    return at > after ? at : null;
  }
  let day = etDate(after);
  if (s.kind === "interval" && s.start_date > day) day = s.start_date;
  for (let i = 0; i < 800; i++) {
    if (matchesDay(s, day)) {
      const at = etToUtc(day, s.time);
      if (at > after) return at;
    }
    day = addDaysISO(day, 1);
  }
  return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function time12(time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  const h = hh % 12 === 0 ? 12 : hh % 12;
  return `${h}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"} ET`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function describeSchedule(s: Schedule): string {
  const at = time12(s.time);
  switch (s.kind) {
    case "once":
      return `Once on ${s.date} at ${at}`;
    case "daily":
      return `Every day at ${at}`;
    case "weekly":
      return s.days.length === 7
        ? `Every day at ${at}`
        : `Every ${s.days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
    case "monthly":
      return `Monthly on the ${ordinal(s.day_of_month)} at ${at}`;
    case "interval":
      return `Every ${s.every_days} days at ${at} (from ${s.start_date})`;
  }
}
