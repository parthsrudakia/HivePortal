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
import { logEmail } from "./email-log";

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

  const result = error
    ? { ok: false as const, error: error.message }
    : data?.id
      ? { ok: true as const, id: data.id }
      : { ok: false as const, error: "No id returned from Resend" };
  await logEmail({
    type: "room_change",
    recipient: input.to.join(", "),
    subject,
    context: unitRoom,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
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
    // The move-out cleaning happens on the move-out date itself (the room's
    // availability date). Dating the cleaning record here also anchors the
    // property's regular 35-day cadence at availability_date + 35 once it passes.
    cleaningDate = toDate;
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

  if (!action) return;

  // 2. Look up every cleaner assigned to this unit and email each of them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: assignments } = await (supabase as any)
    .from("property_cleaners")
    .select("cleaners(email, enabled)")
    .eq("property_id", property.id);
  type CleanerShape = { email: string | null; enabled: boolean };
  type AssignmentRow = {
    cleaners: CleanerShape | CleanerShape[] | null;
  };
  const recipientEmails = ((assignments ?? []) as AssignmentRow[])
    .map((a) => one(a.cleaners))
    .filter((c): c is CleanerShape => !!c && c.enabled !== false && !!c.email)
    .map((c) => c.email as string);
  if (recipientEmails.length === 0) return;

  const unitLabel = `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`;
  const roomLabel = room.room_number ?? "Room";

  // Pull every tenancy for this property so the cleaner always gets a contact
  // for each room: the current tenant if occupied, or the last tenant who
  // vacated it if the room is now empty.
  const { data: tenancyRows } = await supabase
    .from("tenancies")
    .select(
      "status, start_date, room_id, rooms!inner(room_number, property_id), tenants(full_name, email, phone)",
    )
    .eq("rooms.property_id", property.id)
    .order("start_date", { ascending: false });

  type TenantRow = {
    status: string;
    start_date: string;
    room_id: string;
    rooms: { room_number: string | null } | { room_number: string | null }[] | null;
    tenants:
      | { full_name: string; email: string | null; phone: string | null }
      | { full_name: string; email: string | null; phone: string | null }[]
      | null;
  };
  // One contact per room: rows are newest-first, so the first seen per room is
  // the latest tenancy; only override it when a later row is the active one.
  const chosenByRoom = new Map<string, TenantRow>();
  for (const r of (tenancyRows ?? []) as TenantRow[]) {
    if (!one(r.tenants)) continue;
    const cur = chosenByRoom.get(r.room_id);
    if (!cur || (cur.status !== "active" && r.status === "active")) {
      chosenByRoom.set(r.room_id, r);
    }
  }
  const occupants: OccupantInfo[] = [...chosenByRoom.values()]
    .map((r) => {
      const room = one(r.rooms);
      const tenant = one(r.tenants);
      if (!tenant) return null;
      return {
        room_number: room?.room_number ?? null,
        full_name: tenant.full_name,
        email: tenant.email,
        phone: tenant.phone,
        vacated: r.status !== "active",
      };
    })
    .filter((x): x is OccupantInfo => x !== null)
    .sort((a, b) => (a.room_number ?? "").localeCompare(b.room_number ?? ""));

  for (const to of recipientEmails) {
    await sendCleaningEmail({
      to,
      action,
      unitLabel,
      roomLabel,
      newDate: cleaningDate,
      oldDate: oldCleaningDate,
      leaseholderName,
      occupants,
    });
  }
}

type OccupantInfo = {
  room_number: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  vacated: boolean; // true = last tenant of a now-vacant room
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
    lines.push("Tenants: none on record");
  } else {
    lines.push("Tenants:");
    for (const o of input.occupants) {
      const contact = [o.email, o.phone].filter(Boolean).join(" · ") || "no contact on file";
      const room = o.room_number ? ` (${o.room_number})` : "";
      const tag = o.vacated ? " — VACATED THIS ROOM" : "";
      lines.push(`- ${o.full_name}${room} — ${contact}${tag}`);
    }
  }
  return lines.join("\n");
}

function prettyDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Mobile-first contact list: one tenant per row with big tap targets — tap the
// number to call, the address to email. The last tenant of a now-empty room is
// flagged with a "Vacated" badge.
function contactsHtml(input: CleaningEmailInput): string {
  if (!input.occupants || input.occupants.length === 0) {
    return `<p style="margin:0; font-size:15px; color:#8a8378;">No tenants on record.</p>`;
  }
  return input.occupants
    .map((o) => {
      const room = o.room_number
        ? ` <span style="font-weight:400; color:#8a8378;">· ${o.room_number}</span>`
        : "";
      const badge = o.vacated
        ? ` <span style="display:inline-block; background:#fbeccc; color:#9a6f08; font-size:11px; font-weight:600; padding:1px 8px; border-radius:999px;">Vacated</span>`
        : "";
      const links: string[] = [];
      if (o.phone)
        links.push(
          `<a href="tel:${o.phone.replace(/[^\d+]/g, "")}" style="display:inline-block; color:#9a6f08; text-decoration:none; font-weight:600; padding:8px 0; margin-right:20px;">📞 ${o.phone}</a>`,
        );
      if (o.email)
        links.push(
          `<a href="mailto:${o.email}" style="display:inline-block; color:#9a6f08; text-decoration:none; font-weight:600; padding:8px 0; word-break:break-all;">✉️ ${o.email}</a>`,
        );
      const contact = links.length
        ? `<div style="margin-top:2px; font-size:15px; line-height:1.4;">${links.join("")}</div>`
        : `<div style="margin-top:2px; font-size:14px; color:#8a8378;">No contact on file</div>`;
      return `<div style="padding:12px 0; border-bottom:1px solid #e8e3db;">
        <div style="font-size:16px; font-weight:600; color:#1a1a18;">${o.full_name}${room}${badge}</div>
        ${contact}
      </div>`;
    })
    .join("");
}

function cardHtml(input: CleaningEmailInput): string {
  const lh = input.leaseholderName ?? "—";

  let statusLabel: string;
  let pillBg: string;
  let pillColor: string;
  let dateLabel: string;
  let bigDate: string;
  let subDate = "";

  if (input.action === "scheduled") {
    statusLabel = "Scheduled";
    pillBg = "#fbeccc";
    pillColor = "#9a6f08";
    dateLabel = "Cleaning date";
    bigDate = prettyDate(input.newDate);
  } else if (input.action === "rescheduled") {
    statusLabel = "Rescheduled";
    pillBg = "#fbeccc";
    pillColor = "#9a6f08";
    dateLabel = "New cleaning date";
    bigDate = prettyDate(input.newDate);
    subDate = `<p style="margin:6px 0 0; font-size:13px; color:#8a8378;">Was ${prettyDate(input.oldDate)}</p>`;
  } else {
    statusLabel = "Cancelled";
    pillBg = "#f6e3e1";
    pillColor = "#a23b2b";
    dateLabel = "Cancelled";
    bigDate = `<span style="text-decoration:line-through; color:#8a8378;">${prettyDate(input.oldDate)}</span>`;
    subDate = `<p style="margin:6px 0 0; font-size:13px; color:#8a8378;">This cleaning is no longer scheduled.</p>`;
  }

  return `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <span style="display:inline-block; background:${pillBg}; color:${pillColor}; font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; padding:4px 12px; border-radius:999px;">${statusLabel}</span>
      <h1 style="margin:14px 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Move-out cleaning</h1>
      <p style="margin:0; font-size:15px; color:#8a8378;">${input.unitLabel} <span style="color:#c4bdb3;">·</span> Room ${input.roomLabel}</p>
      <div style="margin:20px 0; background:#f5f2ed; border-radius:12px; padding:16px 18px;">
        <p style="margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">${dateLabel}</p>
        <p style="margin:4px 0 0; font-size:20px; font-weight:600; color:#1a1a18;">${bigDate}</p>
        ${subDate}
      </div>
      <p style="margin:0 0 2px; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">Tenant contacts</p>
      <p style="margin:0 0 6px; font-size:13px; color:#8a8378;">Leaseholder: ${lh}</p>
      ${contactsHtml(input)}
    </div>
    <div style="padding:14px 20px; background:#f5f2ed; border-top:1px solid #e8e3db;">
      <p style="margin:0; font-size:12px; color:#8a8378;">Hive Portal · automated cleaning notice. Tap a phone number to call or an address to email.</p>
    </div>
  </div>
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
  let intro: string;

  if (input.action === "scheduled") {
    subject = `Cleaning scheduled — ${unitRoom}`;
    intro = `A move-out cleaning is scheduled for ${input.roomLabel} on ${prettyDate(input.newDate)}.`;
  } else if (input.action === "rescheduled") {
    subject = `Cleaning rescheduled — ${unitRoom}`;
    intro = `The move-out cleaning for ${input.roomLabel} has moved to ${prettyDate(input.newDate)} (was ${prettyDate(input.oldDate)}).`;
  } else {
    subject = `Cleaning cancelled — ${unitRoom}`;
    intro = `The move-out cleaning for ${input.roomLabel} set for ${prettyDate(input.oldDate)} is now cancelled.`;
  }

  const fullBody = [
    `Move-out cleaning — ${input.unitLabel} · Room ${input.roomLabel}`,
    "",
    intro,
    "",
    unitDetailsText(input),
  ].join("\n");
  const html = cardHtml(input);

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    replyTo,
    subject,
    text: fullBody,
    html,
  });

  const result = error
    ? { ok: false as const, error: error.message }
    : data?.id
      ? { ok: true as const, id: data.id }
      : { ok: false as const, error: "No id returned from Resend" };
  await logEmail({
    type: "cleaning_moveout",
    recipient: input.to,
    subject,
    context: unitRoom,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
}
