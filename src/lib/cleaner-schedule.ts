import type { SupabaseClient } from "@supabase/supabase-js";
import { one } from "@/lib/relations";

export type CleanerCleaning = {
  id: string;
  propertyId: string;
  unitLabel: string;
  date: string; // ISO YYYY-MM-DD
  isMoveOut: boolean;
  roomLabel: string | null;
  notes: string | null;
};

/** Public URL of a cleaner's stable schedule page. */
export function scheduleUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  return `${base}/s/${token}`;
}

/** The property ids a cleaner is assigned to (via property_cleaners). */
async function assignedPropertyIds(
  supabase: SupabaseClient,
  cleanerId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("property_cleaners")
    .select("property_id")
    .eq("cleaner_id", cleanerId);
  return ((data ?? []) as { property_id: string }[]).map((r) => r.property_id);
}

/**
 * Every cleaning assigned to a cleaner within [from, to] (inclusive ISO dates),
 * sorted by date then unit. Used by the public schedule page and to decide who
 * gets a weekly digest.
 */
export async function getCleanerWeekSchedule(
  supabase: SupabaseClient,
  cleanerId: string,
  from: string,
  to: string,
): Promise<CleanerCleaning[]> {
  const propertyIds = await assignedPropertyIds(supabase, cleanerId);
  if (propertyIds.length === 0) return [];

  type Row = {
    id: string;
    property_id: string;
    cleaning_date: string;
    kind: string | null;
    notes: string | null;
    rooms: { room_number: string | null } | { room_number: string | null }[] | null;
    properties:
      | { building_name: string | null; street_address: string; unit_number: string }
      | { building_name: string | null; street_address: string; unit_number: string }[]
      | null;
  };
  const { data } = await supabase
    .from("cleaning_records")
    .select(
      "id, property_id, cleaning_date, kind, notes, rooms(room_number), properties(building_name, street_address, unit_number)",
    )
    .in("property_id", propertyIds)
    .gte("cleaning_date", from)
    .lte("cleaning_date", to)
    .returns<Row[]>();

  const cleanings: CleanerCleaning[] = ((data ?? []) as Row[]).map((r) => {
    const p = one(r.properties);
    const unitLabel = p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : "Unknown unit";
    const isMoveOut = r.kind === "move_out";
    return {
      id: r.id,
      propertyId: r.property_id,
      unitLabel,
      date: r.cleaning_date,
      isMoveOut,
      roomLabel: isMoveOut ? one(r.rooms)?.room_number ?? null : null,
      notes: r.notes,
    };
  });

  cleanings.sort(
    (a, b) => a.date.localeCompare(b.date) || a.unitLabel.localeCompare(b.unitLabel),
  );
  return cleanings;
}
