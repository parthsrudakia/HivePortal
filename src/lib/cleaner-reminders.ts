import type { SupabaseClient } from "@supabase/supabase-js";
import { currentWeek, addDaysISO } from "@/lib/date";
import { one } from "@/lib/relations";
import { getCleanerWeekSchedule, scheduleUrl } from "@/lib/cleaner-schedule";
import {
  sendCleanerWeeklyDigest,
  sendCleanerScheduleUpdate,
  cleanerWeeklyText,
  cleanerUpdateText,
  type CleanerDigest,
} from "@/lib/email";
import { sendSms, toE164 } from "@/lib/sms";

type CleanerRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  enabled: boolean;
  schedule_token: string;
};

const CLEANER_SELECT = "id, name, email, phone, enabled, schedule_token";

function digestFor(c: CleanerRow, weekStart: string, cleanings: CleanerDigest["cleanings"]): CleanerDigest {
  return {
    cleanerName: c.name,
    weekStart,
    weekEnd: addDaysISO(weekStart, 6),
    url: scheduleUrl(c.schedule_token),
    cleanings,
  };
}

/**
 * Enqueue a debounced "schedule changed" notice for the cleaners of a property —
 * but only when the change touches the CURRENT week (Sun–Sat). Called from every
 * cleaning mutation (manual edits + move-out scheduling). The evening cron
 * (flushCleanerScheduleChanges) drains the queue and sends one notice per
 * cleaner so a day's worth of changes go out together.
 */
export async function enqueueCleanerScheduleChange(
  supabase: SupabaseClient,
  propertyId: string,
  dates: (string | null | undefined)[],
  reason: string,
) {
  const { start, end } = currentWeek();
  const touchesThisWeek = dates.some((d) => !!d && d >= start && d <= end);
  if (!touchesThisWeek) return;

  const { data: links } = await supabase
    .from("property_cleaners")
    .select("cleaners(id, enabled)")
    .eq("property_id", propertyId);
  type Shape = { id: string; enabled: boolean };
  const cleaners = ((links ?? []) as { cleaners: Shape | Shape[] | null }[])
    .map((l) => one(l.cleaners))
    .filter((c): c is Shape => !!c && c.enabled !== false);
  if (cleaners.length === 0) return;

  await supabase.from("cleaner_schedule_change_queue").insert(
    cleaners.map((c) => ({ cleaner_id: c.id, week_start: start, reason })),
  );
}

/**
 * Sunday weekly digest. Email + text every enabled cleaner who has at least one
 * cleaning this week, with a link to their live schedule page.
 */
export async function sendWeeklyCleanerSchedules(supabase: SupabaseClient) {
  const { start, end } = currentWeek();
  const { data } = await supabase
    .from("cleaners")
    .select(CLEANER_SELECT)
    .eq("enabled", true)
    .returns<CleanerRow[]>();
  const cleaners = data ?? [];

  let recipients = 0;
  let emailed = 0;
  let texted = 0;
  for (const c of cleaners) {
    const cleanings = await getCleanerWeekSchedule(supabase, c.id, start, end);
    if (cleanings.length === 0) continue; // only cleaners with cleanings
    recipients++;
    const digest = digestFor(c, start, cleanings);
    if (c.email) {
      const r = await sendCleanerWeeklyDigest(c.email, digest);
      if (r.ok) emailed++;
    }
    const phone = toE164(c.phone);
    if (phone) {
      const r = await sendSms(phone, cleanerWeeklyText(digest), {
        type: "cleaner_weekly",
        context: c.name ?? undefined,
      });
      if (r.ok) texted++;
    }
  }
  return { week: start, recipients, emailed, texted };
}

/**
 * Drain the debounced change queue. Groups pending rows by cleaner+week, sends a
 * single "schedule updated" notice each (email + text), and stamps sent_at so
 * they don't re-send. Runs in the evening cron (~8–9pm ET).
 */
export async function flushCleanerScheduleChanges(supabase: SupabaseClient) {
  type Pending = { id: string; cleaner_id: string; week_start: string };
  const { data } = await supabase
    .from("cleaner_schedule_change_queue")
    .select("id, cleaner_id, week_start")
    .is("sent_at", null)
    .returns<Pending[]>();
  const rows = data ?? [];
  if (rows.length === 0) return { pending: 0, notified: 0, emailed: 0, texted: 0 };

  const byKey = new Map<
    string,
    { cleanerId: string; weekStart: string; ids: string[] }
  >();
  for (const r of rows) {
    const key = `${r.cleaner_id}|${r.week_start}`;
    const g = byKey.get(key) ?? {
      cleanerId: r.cleaner_id,
      weekStart: r.week_start,
      ids: [],
    };
    g.ids.push(r.id);
    byKey.set(key, g);
  }

  const cleanerIds = Array.from(new Set(rows.map((r) => r.cleaner_id)));
  const { data: cleanersData } = await supabase
    .from("cleaners")
    .select(CLEANER_SELECT)
    .in("id", cleanerIds)
    .returns<CleanerRow[]>();
  const cleanerById = new Map((cleanersData ?? []).map((c) => [c.id, c]));

  const now = new Date().toISOString();
  let emailed = 0;
  let texted = 0;
  let notified = 0;
  for (const g of byKey.values()) {
    const c = cleanerById.get(g.cleanerId);
    if (c && c.enabled !== false) {
      const cleanings = await getCleanerWeekSchedule(
        supabase,
        c.id,
        g.weekStart,
        addDaysISO(g.weekStart, 6),
      );
      const digest = digestFor(c, g.weekStart, cleanings);
      if (c.email) {
        const r = await sendCleanerScheduleUpdate(c.email, digest);
        if (r.ok) emailed++;
      }
      const phone = toE164(c.phone);
      if (phone) {
        const r = await sendSms(phone, cleanerUpdateText(digest), {
          type: "cleaner_update",
          context: c.name ?? undefined,
        });
        if (r.ok) texted++;
      }
      notified++;
    }
    // Stamp sent even if the cleaner is gone/disabled, so the queue drains.
    await supabase
      .from("cleaner_schedule_change_queue")
      .update({ sent_at: now })
      .in("id", g.ids);
  }
  return { pending: rows.length, notified, emailed, texted };
}
