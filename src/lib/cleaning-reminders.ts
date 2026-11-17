import type { SupabaseClient } from "@supabase/supabase-js";
import { todayISO, addDaysISO } from "@/lib/date";
import { CLEANING_CADENCE_DAYS } from "@/lib/cleaning";

/**
 * Keep the 35-day cadence rolling. For every unit that has been scheduled at
 * least once (has any cleaning_records) but has no upcoming cleaning, create the
 * next one at the last date + 35, stepped forward to today or later. Units that
 * have never been scheduled are skipped — the operator sets the first date.
 *
 * A future move-out cleaning only covers the room being vacated, so it is not
 * the unit's next regular cleaning: a move-out booked months ahead must not
 * pause the 35-day cadence until then. Future move-out rows are therefore left
 * out of both the "has an upcoming cleaning" check and the "last cleaning"
 * date (same rule as the /cleaning page note in notifications.ts). Past
 * move-out cleanings still count as the unit's last cleaning.
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
  for (const r of data ?? []) {
    const futureMoveOut = r.kind === "move_out" && r.cleaning_date >= today;
    if (futureMoveOut) continue;
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
    inserts.push({ property_id: propertyId, cleaning_date: next });
  }

  if (inserts.length > 0) {
    await supabase.from("cleaning_records").insert(inserts);
  }
  return { rolled: inserts.length };
}
