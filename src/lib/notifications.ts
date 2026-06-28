/**
 * Room-change notifications: when a room's status or listing_action changes,
 * email every enabled recipient in notification_recipients. Each change is
 * also logged in room_change_events so a daily cron can send a 24h follow-up.
 *
 * Call updateRoomsWithNotification() instead of the raw rooms.update() so
 * mutation sites stay centralized.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { one } from "@/lib/relations";
import { sendViaResend, type SendResult } from "./resend-quota";
import { enqueueCleanerScheduleChange } from "@/lib/cleaner-reminders";
import { todayISO } from "@/lib/date";

function resendFrom() {
  return process.env.RESEND_FROM || "onboarding@resend.dev";
}
import { CLEANING_CADENCE_DAYS } from "@/lib/cleaning";

/** Add `days` to an ISO "YYYY-MM-DD" date, returning the same format. */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

const ACTION_LABELS: Record<string, string> = {
  no_action: "No action",
  update_price_or_date: "Update price/date",
  delete_listing: "Delete listing",
  boost_post: "Boost post",
  priority: "Priority listing",
};

function fieldLabel(field: "status" | "listing_action"): string {
  return field === "status" ? "Status" : "Listing action";
}

function valueLabel(field: "status" | "listing_action", v: string | null): string {
  if (!v) return "—";
  const map = field === "status" ? STATUS_LABELS : ACTION_LABELS;
  return map[v] ?? v;
}

// Watched fields. Edits to other columns don't trigger notifications.
const WATCHED = ["status", "listing_action"] as const;
type Watched = (typeof WATCHED)[number];

type RoomPatch = Record<string, unknown> &
  Partial<Record<Watched, string>> & {
    available_from?: string | null;
  };

// Accepts both the typed server client and the untyped service-role client.
// Bare SupabaseClient (default generics) keeps `.from()`/`.update()` permissive
// without writing an explicit `any`.
type AnyClient = SupabaseClient;

/**
 * Drop-in wrapper for `rooms.update(patch).in("id", roomIds)`. Reads the old
 * watched values first, applies the update, diffs, then logs + emails for
 * each changed watched field.
 */
export async function updateRoomsWithNotification(
  supabase: AnyClient,
  roomIds: string | string[],
  patch: RoomPatch,
): Promise<{ error: { message: string } | null }> {
  const ids = (Array.isArray(roomIds) ? roomIds : [roomIds]).filter(Boolean);
  if (ids.length === 0) return { error: null };

  const willChange = WATCHED.filter((f) => f in patch);
  const availableFromTouched = "available_from" in patch;

  type BeforeRow = { id: string; available_from: string | null } & Partial<
    Record<Watched, string>
  >;
  const before = new Map<string, BeforeRow>();

  const needSelect = willChange.length > 0 || availableFromTouched;
  if (needSelect) {
    const sel = ["id", "available_from", ...willChange].join(", ");
    const { data } = await supabase
      .from("rooms")
      .select(sel)
      .in("id", ids)
      .returns<BeforeRow[]>();
    for (const row of data ?? []) before.set(row.id, row);
  }

  const { error } = await supabase.from("rooms").update(patch).in("id", ids);
  if (error) return { error };

  if (!needSelect) return { error: null };

  for (const id of ids) {
    const old = before.get(id);
    if (!old) continue;
    for (const f of willChange) {
      const fromV = old[f] ?? null;
      const toV = patch[f] ?? null;
      if (fromV === toV) continue;
      await recordChangeAndEmail(supabase, id, f, fromV, toV);
    }
    if (availableFromTouched) {
      const fromDate = old.available_from ?? null;
      const toDate = (patch.available_from as string | null | undefined) ?? null;
      if (fromDate !== toDate) {
        await handleAvailableFromChange(supabase, id, fromDate, toDate);
      }
    }
  }
  return { error: null };
}

async function recordChangeAndEmail(
  supabase: AnyClient,
  roomId: string,
  field: Watched,
  fromV: string | null,
  toV: string | null,
) {
  // 1. Log the event.
  const { data: event, error: insErr } = await supabase
    .from("room_change_events")
    .insert({ room_id: roomId, field, from_value: fromV, to_value: toV })
    .select("id")
    .single();
  if (insErr || !event) return;

  // 2. Fetch context (room + property) and recipients in parallel.
  const [roomRes, recipientsRes] = await Promise.all([
    supabase
      .from("rooms")
      .select(
        "room_number, properties(building_name, street_address, unit_number)",
      )
      .eq("id", roomId)
      .maybeSingle(),
    supabase
      .from("notification_recipients")
      .select("email")
      .eq("enabled", true),
  ]);

  const room = roomRes.data as {
    room_number: string | null;
    properties:
      | {
          building_name: string | null;
          street_address: string;
          unit_number: string;
        }
      | Array<{
          building_name: string | null;
          street_address: string;
          unit_number: string;
        }>
      | null;
  } | null;

  const property = one(room?.properties ?? null) as {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  } | null;

  const recipients = ((recipientsRes.data ?? []) as Array<{ email: string }>)
    .map((r) => r.email?.trim())
    .filter((e): e is string => !!e);

  if (recipients.length === 0) {
    // No one to notify, leave immediate_sent_at null.
    return;
  }

  // 3. Send the immediate email.
  const unitLabel = property
    ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
    : "Unknown unit";
  const roomLabel = room?.room_number ?? "Room";

  const result = await sendChangeEmail({
    kind: "immediate",
    to: recipients,
    unitLabel,
    roomLabel,
    field,
    fromV,
    toV,
  });

  await supabase
    .from("room_change_events")
    .update({
      immediate_sent_at: result.ok ? new Date().toISOString() : null,
      immediate_error: result.ok ? null : result.error,
    })
    .eq("id", event.id);
}

export type ChangeEmailInput = {
  kind: "immediate" | "followup";
  to: string[];
  unitLabel: string;
  roomLabel: string;
  field: "status" | "listing_action";
  fromV: string | null;
  toV: string | null;
};

export async function sendChangeEmail(
  input: ChangeEmailInput,
): Promise<SendResult> {
  const fromLabel = valueLabel(input.field, input.fromV);
  const toLabel = valueLabel(input.field, input.toV);
  const fLabel = fieldLabel(input.field);

  const unitRoom = `${input.unitLabel} · ${input.roomLabel}`;
  const subject =
    input.kind === "immediate"
      ? `Room update — ${unitRoom}`
      : `Reminder — ${unitRoom}`;

  const text =
    input.kind === "immediate"
      ? `Hi,

Just letting you know that ${unitRoom} just had its ${fLabel.toLowerCase()} change from "${fromLabel}" to "${toLabel}". Please act on this.

Thanks`
      : `Hi,

This is a follow-up on the change to ${unitRoom} from "${fromLabel}" to "${toLabel}" (${fLabel.toLowerCase()}) yesterday. Have you acted on it yet?

Thanks`;

  const intro =
    input.kind === "immediate"
      ? `Just letting you know that <strong>${unitRoom}</strong> just had its ${fLabel.toLowerCase()} change from <strong>${fromLabel}</strong> to <strong>${toLabel}</strong>. Please act on this.`
      : `This is a follow-up on the change to <strong>${unitRoom}</strong> from <strong>${fromLabel}</strong> to <strong>${toLabel}</strong> (${fLabel.toLowerCase()}) yesterday. Have you acted on it yet?`;

  const html = `<div style="font-family: 'DM Sans', Arial, sans-serif; color:#1a1a18; max-width:560px; line-height:1.5;">
  <p>Hi,</p>
  <p>${intro}</p>
  <p>Thanks</p>
</div>`;

  return sendViaResend(
    { to: input.to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
    { type: "room_change", context: unitRoom },
  );
}


// ----- Move-out cleaning scheduler -----
//
// Triggered from updateRoomsWithNotification when a room's available_from
// transitions:
//   null → date      schedule a move-out cleaning the day before
//   date1 → date2    move the existing move-out cleaning (or create one)
//   date → null      cancel any future move-out cleaning for this room
//
// Move-out cleaning rows are stored in cleaning_records with kind='move_out'
// and the specific room_id. Future-dated rows are excluded from the regular
// next-due computation (see /cleaning page).

async function handleAvailableFromChange(
  supabase: AnyClient,
  roomId: string,
  fromDate: string | null,
  toDate: string | null,
) {
  // Look up the property, cleaner, and room number we need for both the DB
  // write and the email.
  const { data: room } = await supabase
    .from("rooms")
    .select(
      "id, room_number, property_id, properties(id, building_name, street_address, unit_number, leaseholders(name))",
    )
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return;

  type LeaseholderShape = { name: string };
  type PropertyShape = {
    id: string;
    building_name: string | null;
    street_address: string;
    unit_number: string;
    leaseholders: LeaseholderShape | LeaseholderShape[] | null;
  };
  const property = one(
    (room as { properties: PropertyShape | PropertyShape[] | null }).properties,
  ) as PropertyShape | null;
  if (!property) return;

  const today = todayISO();

  // 1. Find the existing pending move-out cleaning for this room (if any).
   
  const { data: existing } = await supabase
    .from("cleaning_records")
    .select("id, cleaning_date")
    .eq("room_id", roomId)
    .eq("kind", "move_out")
    .gte("cleaning_date", today)
    .maybeSingle();

  let action: "scheduled" | "rescheduled" | "cancelled" | null = null;
  let cleaningDate: string | null = null;
  let resetDate: string | null = null;
  const oldCleaningDate: string | null = existing?.cleaning_date ?? null;

  if (toDate) {
    // The move-out cleaning happens on the move-out date itself (the room's
    // availability date). Dating the cleaning record here also anchors the
    // property's regular 35-day cadence at availability_date + 35 once it passes.
    cleaningDate = toDate;
    if (existing) {
       
      await supabase
        .from("cleaning_records")
        .update({ cleaning_date: cleaningDate })
        .eq("id", existing.id);
      action = existing.cleaning_date === cleaningDate ? null : "rescheduled";
    } else {
       
      const { error: insErr } = await supabase
        .from("cleaning_records")
        .insert({
          property_id: property.id,
          room_id: roomId,
          cleaning_date: cleaningDate,
          kind: "move_out",
          notes: `Move-out cleaning for ${room.room_number ?? "room"}`,
        });
      if (!insErr) action = "scheduled";
    }

    // The move-out becomes the unit's next cleaning, so the cadence re-anchors
    // to it (the one after lands at move-out + 35). Clear any regular upcoming
    // cleaning for the unit so it doesn't compete with the move-out date.
    await supabase
      .from("cleaning_records")
      .delete()
      .eq("property_id", property.id)
      .gte("cleaning_date", today)
      .or("kind.is.null,kind.neq.move_out");
  } else if (existing) {
    // toDate is null and there's an existing scheduled move-out → cancel.

    await supabase
      .from("cleaning_records")
      .delete()
      .eq("id", existing.id);
    action = "cancelled";

    // The move-out had re-anchored the regular cadence to the move-out date.
    // With it gone, the next cleaning reverts to "last cleaning + 35 days".
    // Surface that original date to the cleaner so they know what to expect.
    const { data: lastClean } = await supabase
      .from("cleaning_records")
      .select("cleaning_date")
      .eq("property_id", property.id)
      .lte("cleaning_date", today)
      .order("cleaning_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastClean?.cleaning_date) {
      resetDate = addDaysISO(lastClean.cleaning_date, CLEANING_CADENCE_DAYS);
    }
  }

  if (!action) return;

  // Manual/move-out schedule changes are debounced — enqueue a "schedule
  // updated" notice for this unit's cleaners (sent by the evening cron), only
  // when a change touches the current week.
  await enqueueCleanerScheduleChange(
    supabase,
    property.id,
    [cleaningDate, oldCleaningDate, resetDate],
    "move_out",
  );
}
