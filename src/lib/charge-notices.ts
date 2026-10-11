/**
 * Delayed "Other" charge emails. Adding an Other charge parks a
 * charge_notices row due 5 minutes later instead of emailing right away, so
 * the operator can still fix a mistake. Deleting the charge cascades the row
 * away (no email); a correction is delete + re-add, which gets its own fresh
 * 5 minutes. The email is built from the charge row as it stands at send
 * time. Flushed every minute by pg_cron → /api/cron/charge-notices, and by
 * the daily follow-up cron as a safety net.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { roomLabel } from "@/lib/room-label";
import { todayISO } from "@/lib/date";
import {
  sendOtherChargeNotice,
  sendOtherChargeNoticeGmail,
} from "@/lib/email";

export const CHARGE_NOTICE_DELAY_MS = 5 * 60 * 1000;

type Admin = SupabaseClient<Database>;

function admin(): Admin {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Schedules the tenant email for a just-added Other charge. */
export async function scheduleChargeNotice(chargeId: string): Promise<void> {
  const { error } = await admin()
    .from("charge_notices")
    .insert({
      charge_id: chargeId,
      send_after: new Date(Date.now() + CHARGE_NOTICE_DELAY_MS).toISOString(),
    });
  if (error) throw new Error(error.message);
}

/** Sends every due notice whose charge still exists. */
export async function flushChargeNotices(
  supabase: Admin = admin(),
): Promise<{ sent: number; skipped: number; failed: number; error?: string }> {
  const { data: due, error } = await supabase.rpc("claim_due_charge_notices");
  if (error) return { sent: 0, skipped: 0, failed: 0, error: error.message };

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const n of due ?? []) {
    try {
      const result = await sendChargeNotice(supabase, n.charge_id);
      if (result === "skipped") {
        // Deleted between the claim and now (or no tenant email): nothing to send.
        await supabase.from("charge_notices").delete().eq("charge_id", n.charge_id);
        skipped++;
        continue;
      }
      await supabase
        .from("charge_notices")
        .update({ sent_at: new Date().toISOString(), last_error: null })
        .eq("charge_id", n.charge_id);
      sent++;
    } catch (e) {
      // Leave it claimed; it's retried once the claim goes stale (10 min).
      await supabase
        .from("charge_notices")
        .update({ last_error: e instanceof Error ? e.message : String(e) })
        .eq("charge_id", n.charge_id);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

// Emails the tenant about an "Other" charge on their ledger, using the
// charge as it is now. Which rent month to fold it into: this month if
// nothing has been paid on the tenancy yet this calendar month, otherwise
// next month (they've likely already sent what they meant to for this
// month). NY tenants get plain Gmail, everyone else the branded Resend card —
// same split as the utility-charge notice.
async function sendChargeNotice(
  supabase: Admin,
  chargeId: string,
): Promise<"sent" | "skipped"> {
  const { data: charge, error: chargeErr } = await supabase
    .from("tenancy_charges")
    .select("tenancy_id, kind, amount, charged_on, note")
    .eq("id", chargeId)
    .maybeSingle();
  if (chargeErr) throw new Error(chargeErr.message);
  if (!charge || charge.kind !== "other" || !charge.note) return "skipped";

  const { data: row, error: rowErr } = await supabase
    .from("tenancies")
    .select(
      "tenants(email), rooms(room_number, properties(building_name, street_address, unit_number, is_new_york))",
    )
    .eq("id", charge.tenancy_id)
    .maybeSingle();
  if (rowErr) throw new Error(rowErr.message);
  const email = one(row?.tenants ?? null)?.email?.trim();
  if (!email) return "skipped";

  const room = one(row?.rooms ?? null);
  const prop = one(room?.properties ?? null);
  const unitLabel = prop
    ? `${prop.building_name?.trim() || prop.street_address} Apt ${prop.unit_number}${
        roomLabel(room?.room_number) ? ` · ${roomLabel(room?.room_number)}` : ""
      }`
    : "your unit";
  const isNewYork = prop?.is_new_york ?? false;

  const today = todayISO();
  const monthStart = `${today.slice(0, 7)}-01`;
  const { count, error: payErr } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("tenancy_id", charge.tenancy_id)
    .gte("paid_on", monthStart)
    .lte("paid_on", today);
  if (payErr) throw new Error(payErr.message);
  const paidThisMonth = (count ?? 0) > 0;

  const [y, m] = today.slice(0, 7).split("-").map(Number);
  // Date.UTC month is 0-based: `m - 1` is this month, `m` is next.
  const rentMonthLabel = new Date(
    Date.UTC(y, paidThisMonth ? m : m - 1, 1),
  ).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  const notice = {
    amount: Number(charge.amount),
    description: charge.note,
    chargedOn: charge.charged_on,
    unitLabel,
    rentMonthLabel,
  };
  const result = isNewYork
    ? await sendOtherChargeNoticeGmail(email, notice)
    : await sendOtherChargeNotice(email, notice);
  if (!result.ok) throw new Error(result.error);
  return "sent";
}
