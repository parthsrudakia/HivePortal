import type { SupabaseClient } from "@supabase/supabase-js";
import { todayISO, addDaysISO } from "@/lib/date";
import { CLEANING_CADENCE_DAYS, moveOutMonthStart } from "@/lib/cleaning";

/**
 * Keep the 35-day cadence rolling. For every unit that has been scheduled at
 * least once (has any cleaning_records) but has no upcoming regular cleaning,
 * create the next one at the last date + 35, stepped forward to today or
 * later. Units that have never been scheduled are skipped — the operator sets
 * the first date.
 *
 * A booked move-out cleaning is the unit's regular cleaning for its month:
 * no separate regular cleaning is booked in the move-out month (or later),
 * and once the move-out cleaning passes the cadence re-anchors to it (next
 * regular = move-out + 35). Regular cleanings in earlier months keep rolling,
 * so a move-out booked far ahead doesn't pause the unit. Future move-outs
 * don't count as "upcoming" or as the last cleaning; past ones count as the
 * last cleaning. Booking a move-out clears regular cleanings by the same rule
 * (see handleAvailableFromChange in notifications.ts).
 */
export async function runCleaningSchedule(supabase: SupabaseClient) {
  const today = todayISO();
  type Rec = { property_id: string; cleaning_date: string; kind: string | null };
  const { data, error } = await supabase
    .from("cleaning_records")
    .select("property_id, cleaning_date, kind")
    .returns<Rec[]>();
  if (error) return { rolled: 0, error: error.message };

  const latest = new Map<string, string>();
  const hasUpcoming = new Set<string>();
  // Earliest future move-out cleaning per unit.
  const nextMoveOut = new Map<string, string>();
  for (const r of data ?? []) {
    if (r.kind === "move_out" && r.cleaning_date >= today) {
      const cur = nextMoveOut.get(r.property_id);
      if (!cur || r.cleaning_date < cur) nextMoveOut.set(r.property_id, r.cleaning_date);
      continue;
    }
    if (r.cleaning_date >= today) hasUpcoming.add(r.property_id);
    const cur = latest.get(r.property_id);
    if (!cur || r.cleaning_date > cur) latest.set(r.property_id, r.cleaning_date);
  }

  // Paused or retired properties fall out of the cadence entirely.
  const { data: excluded } = await supabase
    .from("properties")
    .select("id, paused_at, archived_at")
    .or("paused_at.not.is.null,archived_at.not.is.null");
  const skipIds = new Set(
    ((excluded ?? []) as { id: string }[]).map((p) => p.id),
  );

  const inserts: { property_id: string; cleaning_date: string }[] = [];
  for (const [propertyId, last] of latest) {
    if (skipIds.has(propertyId)) continue;
    if (hasUpcoming.has(propertyId)) continue; // already has a next cleaning
    let next = addDaysISO(last, CLEANING_CADENCE_DAYS);
    while (next < today) next = addDaysISO(next, CLEANING_CADENCE_DAYS);
    // In (or after) the move-out month the move-out cleaning is the regular
    // cleaning, so don't book a separate one.
    const moveOut = nextMoveOut.get(propertyId);
    if (moveOut && next >= moveOutMonthStart(moveOut)) continue;
    inserts.push({ property_id: propertyId, cleaning_date: next });
  }

  if (inserts.length > 0) {
    await supabase.from("cleaning_records").insert(inserts);
  }
  return { rolled: inserts.length };
}
