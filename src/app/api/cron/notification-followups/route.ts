/**
 * Daily 24h-follow-up cron for room-change notifications.
 *
 * For every row in room_change_events where changed_at is at least 24h old
 * and followup_sent_at is still null, send a follow-up email to every
 * enabled recipient asking whether they acted on the change. Then stamp
 * followup_sent_at so we never re-send.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendChangeEmail } from "@/lib/notifications";
import { runLeaseReminders } from "@/lib/lease-reminders";
import { runCleaningSchedule } from "@/lib/cleaning-reminders";
import { sendWeeklyCleanerSchedules } from "@/lib/cleaner-reminders";
import { isSundayET } from "@/lib/date";
import { flushEmailQueue } from "@/lib/resend-quota";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type EventRow = {
  id: string;
  room_id: string;
  field: "status" | "listing_action";
  from_value: string | null;
  to_value: string | null;
  changed_at: string;
};

type RoomCtx = {
  id: string;
  room_number: string | null;
  properties: {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  } | Array<{
    building_name: string | null;
    street_address: string;
    unit_number: string;
  }> | null;
};

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = admin();

  // Drain any Resend emails deferred on earlier days FIRST, so backlog gets
  // first claim on today's free-tier budget (FIFO). Today's own sends below run
  // through the same chokepoint and re-queue if they then exceed the cap.
  const flush = await flushEmailQueue(supabase);

  // Piggy-backed on this daily cron to stay within the Vercel Hobby cron limit:
  // send any due 45-day lease-ending heads-ups. Independent of the followup work
  // below, so it runs even if there are no room-change events.
  const lease = await runLeaseReminders(supabase);

  // Roll the 35-day cadence forward (create the next cleaning for any unit whose
  // upcoming date has passed). On Sundays, send each cleaner their week's
  // schedule (only cleaners who have at least one cleaning this week).
  const cleaningSchedule = await runCleaningSchedule(supabase);
  const cleanerWeekly = isSundayET()
    ? await sendWeeklyCleanerSchedules(supabase)
    : { skipped: "not Sunday" };

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: events, error } = await (supabase as any)
    .from("room_change_events")
    .select("id, room_id, field, from_value, to_value, changed_at")
    .is("followup_sent_at", null)
    .lte("changed_at", cutoff);

  if (error) {
    return NextResponse.json({ error: error.message, lease, cleaningSchedule, cleanerWeekly, flush }, { status: 500 });
  }

  const rows = (events ?? []) as EventRow[];
  if (rows.length === 0) {
    return NextResponse.json({ followups_due: 0, sent: 0, failed: 0, lease, cleaningSchedule, cleanerWeekly, flush });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recipientsRaw } = await (supabase as any)
    .from("notification_recipients")
    .select("email")
    .eq("enabled", true);
  const recipients = ((recipientsRaw ?? []) as Array<{ email: string }>)
    .map((r) => r.email?.trim())
    .filter((e): e is string => !!e);

  if (recipients.length === 0) {
    // No one to email; mark them done so we don't keep selecting them.
    const ids = rows.map((r) => r.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("room_change_events")
      .update({
        followup_sent_at: new Date().toISOString(),
        followup_error: "no recipients",
      })
      .in("id", ids);
    return NextResponse.json({
      followups_due: rows.length,
      sent: 0,
      failed: 0,
      note: "no enabled recipients",
      lease,
      cleaningSchedule,
      cleanerWeekly,
      flush,
    });
  }

  // Batch-load room + property for every distinct room in the result set.
  const roomIds = Array.from(new Set(rows.map((r) => r.room_id)));
  const { data: roomData } = await supabase
    .from("rooms")
    .select(
      "id, room_number, properties(building_name, street_address, unit_number)",
    )
    .in("id", roomIds)
    .returns<RoomCtx[]>();
  const roomsById = new Map<string, RoomCtx>();
  for (const r of roomData ?? []) roomsById.set(r.id, r);

  let sent = 0;
  let failed = 0;

  for (const ev of rows) {
    const ctx = roomsById.get(ev.room_id);
    const property = pickOne(ctx?.properties ?? null);
    const unitLabel = property
      ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
      : "Unknown unit";
    const roomLabel = ctx?.room_number ?? "Room";

    const result = await sendChangeEmail({
      kind: "followup",
      to: recipients,
      unitLabel,
      roomLabel,
      field: ev.field,
      fromV: ev.from_value,
      toV: ev.to_value,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("room_change_events")
      .update({
        followup_sent_at: new Date().toISOString(),
        followup_error: result.ok ? null : result.error,
      })
      .eq("id", ev.id);

    if (result.ok) sent++;
    else failed++;
  }

  return NextResponse.json({ followups_due: rows.length, sent, failed, lease, cleaningSchedule, cleanerWeekly, flush });
}
