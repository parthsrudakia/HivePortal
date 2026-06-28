import type { SupabaseClient } from "@supabase/supabase-js";
import { todayISO, addDaysISO } from "@/lib/date";
import { CLEANING_CADENCE_DAYS } from "@/lib/cleaning";

/**
 * Keep the 35-day cadence rolling. For every unit that has been scheduled at
 * least once (has any cleaning_records) but has no upcoming cleaning, create the
 * next one at the last date + 35, stepped forward to today or later. Units that
 * have never been scheduled are skipped — the operator sets the first date.
 */
export async function runCleaningSchedule(supabase: SupabaseClient) {
  const today = todayISO();
  type Rec = { property_id: string; cleaning_date: string };
  const { data, error } = await supabase
    .from("cleaning_records")
    .select("property_id, cleaning_date")
    .returns<Rec[]>();
  if (error) return { rolled: 0, error: error.message };

  const latest = new Map<string, string>();
  const hasUpcoming = new Set<string>();
  for (const r of data ?? []) {
    if (r.cleaning_date >= today) hasUpcoming.add(r.property_id);
    const cur = latest.get(r.property_id);
    if (!cur || r.cleaning_date > cur) latest.set(r.property_id, r.cleaning_date);
  }

  const inserts: { property_id: string; cleaning_date: string }[] = [];
  for (const [propertyId, last] of latest) {
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
