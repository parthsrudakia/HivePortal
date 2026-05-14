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

type RoomPatch = Record<string, unknown> & Partial<Record<Watched, string>>;

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
  type BeforeRow = { id: string } & Partial<Record<Watched, string>>;
  const before = new Map<string, BeforeRow>();

  if (willChange.length > 0) {
    const sel = ["id", ...willChange].join(", ");
    const { data } = await supabase
      .from("rooms")
      .select(sel)
      .in("id", ids)
      .returns<BeforeRow[]>();
    for (const row of data ?? []) before.set(row.id, row);
  }

  const { error } = await supabase.from("rooms").update(patch).in("id", ids);
  if (error) return { error };

  if (willChange.length === 0) return { error: null };

  for (const id of ids) {
    const old = before.get(id);
    if (!old) continue;
    for (const f of willChange) {
      const fromV = old[f] ?? null;
      const toV = patch[f] ?? null;
      if (fromV === toV) continue;
      await recordChangeAndEmail(supabase, id, f, fromV, toV);
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
