/**
 * Room-change notifications: when a room's status or listing_action changes,
 * email every enabled recipient in notification_recipients. Each change is
 * also logged in room_change_events so a daily cron can send a 24h follow-up.
 *
 * Call updateRoomsWithNotification() instead of the raw rooms.update() so
 * mutation sites stay centralized.
 *
 * NOTE: after `npm run db:push` ships the new tables, run
 * `npm run db:types` and the `as any` casts below can be removed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { one } from "@/lib/relations";

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

const ACTION_LABELS: Record<string, string> = {
  new_ad: "Create new ad",
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

type AnyClient = SupabaseClient<any, any, any>;

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
  const { data: event, error: insErr } = await (supabase as any)
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
    (supabase as any)
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

  await (supabase as any)
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
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const replyTo = process.env.RESEND_REPLY_TO;

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

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    replyTo,
    subject,
    text,
    html,
  });

  if (error) return { ok: false, error: error.message };
  if (!data?.id) return { ok: false, error: "No id returned from Resend" };
  return { ok: true, id: data.id };
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

function lastDayOfMonthISO(iso: string): string {
  // Day 0 of (month+1) is the last day of the given month.
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

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
      "id, room_number, property_id, properties(id, building_name, street_address, unit_number, cleaner_id, leaseholders(name))",
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
    cleaner_id: string | null;
    leaseholders: LeaseholderShape | LeaseholderShape[] | null;
  };
  const property = one(
    (room as { properties: PropertyShape | PropertyShape[] | null }).properties,
  ) as PropertyShape | null;
  if (!property) return;
  const leaseholderName = one(property.leaseholders)?.name ?? null;

  const today = new Date().toISOString().slice(0, 10);

  // 1. Find the existing pending move-out cleaning for this room (if any).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabase as any)
    .from("cleaning_records")
    .select("id, cleaning_date")
    .eq("room_id", roomId)
    .eq("kind", "move_out")
    .gte("cleaning_date", today)
    .maybeSingle();

  let action: "scheduled" | "rescheduled" | "cancelled" | null = null;
  let cleaningDate: string | null = null;
  let oldCleaningDate: string | null = existing?.cleaning_date ?? null;

  if (toDate) {
    cleaningDate = lastDayOfMonthISO(toDate);
    if (existing) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("cleaning_records")
        .update({ cleaning_date: cleaningDate })
        .eq("id", existing.id);
      action = existing.cleaning_date === cleaningDate ? null : "rescheduled";
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: insErr } = await (supabase as any)
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
  } else if (existing) {
    // toDate is null and there's an existing scheduled move-out → cancel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("cleaning_records")
      .delete()
      .eq("id", existing.id);
    action = "cancelled";
  }

  if (!action || !property.cleaner_id) return;

  // 2. Look up the cleaner and send them an email.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: cleaner } = await (supabase as any)
    .from("cleaners")
    .select("email, enabled")
    .eq("id", property.cleaner_id)
    .maybeSingle();
  if (!cleaner?.email || cleaner.enabled === false) return;

  const unitLabel = `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`;
  const roomLabel = room.room_number ?? "Room";

  // Pull active tenants for this property so the cleaner has contact info.
  const { data: tenancyRows } = await supabase
    .from("tenancies")
    .select(
      "status, rooms!inner(room_number, property_id), tenants(full_name, email, phone)",
    )
    .eq("rooms.property_id", property.id)
    .eq("status", "active");

  type TenantRow = {
    rooms: { room_number: string | null } | { room_number: string | null }[] | null;
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
  };
  const occupants: OccupantInfo[] = ((tenancyRows ?? []) as TenantRow[])
    .map((r) => {
      const room = one(r.rooms);
      const tenant = one(r.tenants);
      if (!tenant) return null;
      return {
        room_number: room?.room_number ?? null,
        full_name: tenant.full_name,
        email: tenant.email,
        phone: tenant.phone,
      };
    })
    .filter((x): x is OccupantInfo => x !== null);

  await sendCleaningEmail({
    to: cleaner.email,
    action,
    unitLabel,
    roomLabel,
    newDate: cleaningDate,
    oldDate: oldCleaningDate,
    leaseholderName,
    occupants,
  });
}

type OccupantInfo = {
  room_number: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
};

export type CleaningEmailInput = {
  to: string;
  action: "scheduled" | "rescheduled" | "cancelled";
  unitLabel: string;
  roomLabel: string;
  newDate: string | null;
  oldDate: string | null;
  leaseholderName?: string | null;
  occupants?: OccupantInfo[];
};

function unitDetailsText(input: CleaningEmailInput): string {
  const lines: string[] = ["Unit details:"];
  lines.push(`Leaseholder: ${input.leaseholderName ?? "—"}`);
  if (!input.occupants || input.occupants.length === 0) {
    lines.push("Current tenants: none");
  } else {
    lines.push("Current tenants:");
    for (const o of input.occupants) {
      const contact = [o.email, o.phone].filter(Boolean).join(" · ") || "no contact on file";
      const room = o.room_number ? ` (${o.room_number})` : "";
      lines.push(`- ${o.full_name}${room} — ${contact}`);
    }
  }
  return lines.join("\n");
}

function unitDetailsHtml(input: CleaningEmailInput): string {
  const lh = input.leaseholderName ?? "—";
  let tenantsBlock: string;
  if (!input.occupants || input.occupants.length === 0) {
    tenantsBlock = `<li style="margin-left:1.2em;">No active tenants.</li>`;
  } else {
    tenantsBlock = input.occupants
      .map((o) => {
        const contact = [o.email, o.phone].filter(Boolean).join(" · ") || "no contact on file";
        const room = o.room_number ? ` <em>(${o.room_number})</em>` : "";
        return `<li><strong>${o.full_name}</strong>${room} — ${contact}</li>`;
      })
      .join("");
    tenantsBlock = `<ul style="margin:0; padding-left:1.2em;">${tenantsBlock}</ul>`;
  }
  return `<div style="margin-top:1.5em; padding-top:1em; border-top:1px solid #c4bdb3;">
  <p style="margin:0 0 0.5em 0;"><strong>Unit details</strong></p>
  <p style="margin:0;">Leaseholder: ${lh}</p>
  <p style="margin:0.5em 0 0.25em 0;">Current tenants:</p>
  ${tenantsBlock}
</div>`;
}

async function sendCleaningEmail(
  input: CleaningEmailInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const replyTo = process.env.RESEND_REPLY_TO;

  const unitRoom = `${input.unitLabel} · ${input.roomLabel}`;

  let subject: string;
  let body: string;
  let bodyHtml: string;

  if (input.action === "scheduled") {
    subject = `Cleaning scheduled — ${unitRoom}`;
    body = `Hi,

The cleaning schedule for ${input.unitLabel} has been updated. This is a move-out cleaning for ${input.roomLabel}, scheduled for ${input.newDate}.

Thanks`;
    bodyHtml = `<p>Hi,</p><p>The cleaning schedule for <strong>${input.unitLabel}</strong> has been updated. This is a <strong>move-out cleaning</strong> for <strong>${input.roomLabel}</strong>, scheduled for <strong>${input.newDate}</strong>.</p><p>Thanks</p>`;
  } else if (input.action === "rescheduled") {
    subject = `Cleaning rescheduled — ${unitRoom}`;
    body = `Hi,

The cleaning schedule for ${input.unitLabel} has been updated. The move-out cleaning for ${input.roomLabel} has been moved from ${input.oldDate} to ${input.newDate}.

Thanks`;
    bodyHtml = `<p>Hi,</p><p>The cleaning schedule for <strong>${input.unitLabel}</strong> has been updated. The <strong>move-out cleaning</strong> for <strong>${input.roomLabel}</strong> has been moved from <strong>${input.oldDate}</strong> to <strong>${input.newDate}</strong>.</p><p>Thanks</p>`;
  } else {
    subject = `Cleaning cancelled — ${unitRoom}`;
    body = `Hi,

The cleaning schedule for ${input.unitLabel} has been updated. The move-out cleaning for ${input.roomLabel} that was set for ${input.oldDate} is now cancelled.

Thanks`;
    bodyHtml = `<p>Hi,</p><p>The cleaning schedule for <strong>${input.unitLabel}</strong> has been updated. The <strong>move-out cleaning</strong> for <strong>${input.roomLabel}</strong> that was set for <strong>${input.oldDate}</strong> is now cancelled.</p><p>Thanks</p>`;
  }

  const fullBody = `${body}\n\n${unitDetailsText(input)}`;
  const html = `<div style="font-family: 'DM Sans', Arial, sans-serif; color:#1a1a18; max-width:560px; line-height:1.5;">${bodyHtml}${unitDetailsHtml(input)}</div>`;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    replyTo,
    subject,
    text: fullBody,
    html,
  });

  if (error) return { ok: false, error: error.message };
  if (!data?.id) return { ok: false, error: "No id returned from Resend" };
  return { ok: true, id: data.id };
}
