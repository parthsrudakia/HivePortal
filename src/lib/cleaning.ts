// Cleaning cadence — every 35 days.
export const CLEANING_CADENCE_DAYS = 35;

/**
 * A booked move-out cleaning stands in for the unit's regular cleaning only
 * when the regular one would fall within this many days before it (or any
 * time after it). A move-out booked further out leaves the regular cadence
 * running until then.
 */
export const MOVE_OUT_COVERS_DAYS = 7;

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
