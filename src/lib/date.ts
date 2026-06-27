/**
 * The portal operates in Eastern Time at all times, regardless of where the
 * server runs or where the user's browser is. The runtime TZ is pinned in
 * src/instrumentation.ts so server-side `toLocaleString`/`toLocaleDateString`
 * and local Date arithmetic resolve to Eastern; this constant is for the few
 * places that must name the zone explicitly (client components, and the
 * `toISOString`-based "today" math below, which is always UTC otherwise).
 */
export const APP_TIME_ZONE = "America/New_York";

/**
 * Today's date as an ISO "YYYY-MM-DD" string in Eastern Time.
 *
 * Do NOT use `new Date().toISOString().slice(0, 10)` for "today" — toISOString
 * is always UTC, so after ~8pm ET it rolls forward to tomorrow's date. This
 * formats with an explicit Eastern zone so it's correct on any host/browser.
 */
export function todayISO(): string {
  // en-CA renders as "YYYY-MM-DD".
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE }).format(
    new Date(),
  );
}

/**
 * The rent billing cycle that contains today, as ISO "YYYY-MM-DD" bounds.
 *
 * Tenants pay from the 27th, so a month's rent is collected from the 27th of
 * the prior month through the 26th of that month. This returns the window for
 * the cycle we're currently in: on/after the 27th we're in the cycle that ends
 * the 26th of next month; before the 27th, the one that ends the 26th of this
 * month. Used for "expected / collected this month" on the Rent Tracker.
 */
export function currentRentCycle(): { start: string; end: string } {
  const [y, m, d] = todayISO().split("-").map(Number); // m is 1-based
  // Base month = the month whose 27th opened the current cycle.
  const baseMonth0 = (d < 27 ? m - 1 : m) - 1; // 0-based month index
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(y, baseMonth0, 27))),
    end: iso(new Date(Date.UTC(y, baseMonth0 + 1, 26))),
  };
}

/**
 * The rent cycle for a given "YYYY-MM" rent month: the 27th of the previous
 * month through the 26th of that month (e.g. "2026-07" → Jun 27 – Jul 26).
 */
export function rentCycleForMonth(yyyymm: string): { start: string; end: string } {
  const [y, m] = yyyymm.split("-").map(Number); // m is 1-based
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(y, m - 2, 27))), // 27th of the prior month
    end: iso(new Date(Date.UTC(y, m - 1, 26))), // 26th of this month
  };
}

/**
 * Display format for all dates in the app: MM/DD/YY.
 * Input is an ISO date string from Postgres ("YYYY-MM-DD") or a timestamptz.
 * Returns "—" for null/empty input.
 *
 * NOTE: don't use this for <input type="date" value=...> — those must stay
 * ISO. Only use for read-only display.
 */
export function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  const ten = s.slice(0, 10);
  const parts = ten.split("-");
  if (parts.length !== 3) return s;
  const [y, m, d] = parts;
  if (!y || !m || !d) return s;
  return `${m}/${d}/${y.slice(2)}`;
}
