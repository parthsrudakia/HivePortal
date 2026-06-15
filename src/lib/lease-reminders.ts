/**
 * Lease-ending reminder logic, factored out of a standalone cron so it can be
 * piggy-backed onto the existing daily notification-followups cron (keeping the
 * total cron count within the Vercel Hobby limit).
 *
 * For every active tenancy whose informational `lease_end_date` is approaching,
 * email the operator a heads-up at two milestones — ~45 days out and ~30 days
 * out. Each milestone has its own flag column so it fires exactly once, and the
 * windows don't overlap so a single day never sends both. The flags are reset to
 * null whenever lease_end_date changes (see setTenancyLeaseEndDate), re-arming
 * both reminders.
 *
 * Purely a notification — it never touches tenancy/room/move-out state.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendLeaseEndReminder } from "@/lib/email";
import { todayISO } from "@/lib/date";
import { one } from "@/lib/relations";

// Reminder milestones, ordered from furthest out to closest. Each fires once
// when lease_end_date enters its window. Windows are made non-overlapping below
// (a milestone's lower bound is the next, closer milestone's threshold) so a
// freshly-set lease date never triggers two emails on the same run.
const MILESTONES = [
  { days: 45, column: "lease_end_reminded_at" },
  { days: 30, column: "lease_end_reminded_30_at" },
] as const;
const REMINDER_TO = process.env.LEASE_REMINDER_TO || "vdutta1485@gmail.com";

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00").getTime();
  const b = new Date(toIso + "T00:00:00").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export type LeaseReminderSummary = {
  candidates: number;
  sent: number;
  failed: number;
  errors: Array<{ tenancy_id: string; error: string }>;
};

export async function runLeaseReminders(
  supabase: SupabaseClient,
): Promise<LeaseReminderSummary> {
  const today = todayISO();
  const summary: LeaseReminderSummary = {
    candidates: 0,
    sent: 0,
    failed: 0,
    errors: [],
  };

  // Process each milestone independently. The window's upper bound is the
  // milestone's day count; the lower bound is the next (closer) milestone's
  // threshold, exclusive, so windows never overlap.
  for (let i = 0; i < MILESTONES.length; i++) {
    const milestone = MILESTONES[i];
    const next = MILESTONES[i + 1];
    const windowEnd = addDaysISO(today, milestone.days);
    // Closer milestones own the days nearer the end; this one starts just past
    // the next milestone's threshold (or `today` for the closest milestone).
    const windowStart = next ? addDaysISO(today, next.days + 1) : today;
    await runMilestone(supabase, milestone.column, windowStart, windowEnd, today, summary);
  }

  return summary;
}

async function runMilestone(
  supabase: SupabaseClient,
  column: string,
  windowStart: string,
  windowEnd: string,
  today: string,
  summary: LeaseReminderSummary,
): Promise<void> {
  // Active tenancies entering this milestone's window that haven't been flagged.
  const { data: rows } = await supabase
    .from("tenancies")
    .select(
      `id, lease_end_date,
       tenants(full_name),
       rooms(room_number, properties(building_name, street_address, unit_number))`,
    )
    .eq("status", "active")
    .is(column, null)
    .not("lease_end_date", "is", null)
    .gte("lease_end_date", windowStart)
    .lte("lease_end_date", windowEnd);

  type Row = {
    id: string;
    lease_end_date: string;
    tenants: { full_name: string } | { full_name: string }[] | null;
    rooms:
      | {
          room_number: string | null;
          properties:
            | { building_name: string | null; street_address: string; unit_number: string }
            | { building_name: string | null; street_address: string; unit_number: string }[]
            | null;
        }
      | {
          room_number: string | null;
          properties: unknown;
        }[]
      | null;
  };

  const list = (rows ?? []) as Row[];
  summary.candidates += list.length;

  for (const row of list) {
    // Reserve the slot first so a re-run can't double-send: only proceed if we
    // flipped this milestone's flag from null to now().
    const stamp = new Date().toISOString();
    const { data: reserved } = await supabase
      .from("tenancies")
      .update({ [column]: stamp })
      .eq("id", row.id)
      .is(column, null)
      .select("id");
    if (!reserved || reserved.length === 0) continue;

    const tenantName = one(row.tenants)?.full_name ?? "A tenant";
    const room = one(row.rooms) as {
      room_number: string | null;
      properties:
        | { building_name: string | null; street_address: string; unit_number: string }
        | { building_name: string | null; street_address: string; unit_number: string }[]
        | null;
    } | null;
    const property = one(room?.properties ?? null);
    const unitLabel = property
      ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}${
          room?.room_number ? ` · ${room.room_number}` : ""
        }`
      : "their unit";
    const daysUntil = diffDays(today, row.lease_end_date);

    const result = await sendLeaseEndReminder(REMINDER_TO, {
      tenantName,
      unitLabel,
      endDate: row.lease_end_date,
      daysUntil,
    });

    if (result.ok) {
      summary.sent++;
    } else {
      // Roll back the reservation so it retries on the next run.
      await supabase
        .from("tenancies")
        .update({ [column]: null })
        .eq("id", row.id);
      summary.failed++;
      summary.errors.push({ tenancy_id: row.id, error: result.error });
    }
  }
}
