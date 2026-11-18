// Cleaning cadence — every 35 days.
export const CLEANING_CADENCE_DAYS = 35;

/**
 * No regular cleaning in a move-out month: that month's regular cleaning IS
 * the move-out cleaning (right after the tenant leaves), and the next regular
 * one lands 35 days after it. Regular cleanings in earlier months keep
 * running, so a move-out booked far ahead doesn't pause the unit.
 *
 * Returns the first day of the move-out's month ("YYYY-MM-01"): regular
 * cleanings dated on or after it are replaced by the move-out cleaning.
 */
export function moveOutMonthStart(moveOutDate: string): string {
  return `${moveOutDate.slice(0, 7)}-01`;
}

export type CleaningStatus = "never" | "overdue" | "due_soon" | "scheduled";

export type CleaningSchedule = {
  last: string | null;       // ISO date "YYYY-MM-DD"
  nextDue: string | null;    // ISO date — null if never cleaned
  daysUntil: number | null;  // negative = overdue
  status: CleaningStatus;
};

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00").getTime();
  const b = new Date(toIso + "T00:00:00").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export function cleaningScheduleFor(
  lastCleaningDate: string | null,
  today: string,
): CleaningSchedule {
  if (!lastCleaningDate) {
    return { last: null, nextDue: null, daysUntil: null, status: "never" };
  }
  const nextDue = addDays(lastCleaningDate, CLEANING_CADENCE_DAYS);
  const daysUntil = diffDays(today, nextDue);
  let status: CleaningStatus;
  if (daysUntil < 0) status = "overdue";
  else if (daysUntil <= 7) status = "due_soon";
  else status = "scheduled";
  return { last: lastCleaningDate, nextDue, daysUntil, status };
}

// Eastern-Time "today"; re-exported so existing `@/lib/cleaning` imports keep working.
export { todayISO } from "@/lib/date";
