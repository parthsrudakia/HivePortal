/**
 * Retry-until-delivered for the "agreement signed" Telegram alert.
 *
 * The signing action sends the alert inline and stamps operator_notified_at
 * only when Telegram confirms the send. This sweep (run from the daily ops
 * cron) picks up any signed request still unstamped — Telegram was down, the
 * action crashed after the claim, the env was misconfigured — and re-sends
 * until it lands. Rows signed in the last 10 minutes are skipped so the sweep
 * never races an in-flight signing into a duplicate alert.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyOperators } from "@/lib/telegram";

const IN_FLIGHT_GRACE_MS = 10 * 60_000;

type SignedRow = {
  id: string;
  tenant_name: string;
  property_address: string;
  recipient_email: string;
  signed_at: string | null;
};

export async function retrySignedAgreementAlerts(
  supabase: SupabaseClient,
): Promise<{ sent: number; pending: number; error?: string }> {
  const cutoff = new Date(Date.now() - IN_FLIGHT_GRACE_MS).toISOString();
  const { data: rows, error } = await supabase
    .from("agreement_requests")
    .select("id, tenant_name, property_address, recipient_email, signed_at")
    .eq("status", "signed")
    .is("operator_notified_at", null)
    .lt("signed_at", cutoff)
    .returns<SignedRow[]>();
  if (error) return { sent: 0, pending: 0, error: error.message };

  let sent = 0;
  for (const row of rows ?? []) {
    const signedAt = row.signed_at
      ? new Date(row.signed_at).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }) + " ET"
      : "earlier";
    const ok = await notifyOperators(
      [
        `✍️ ${row.tenant_name} signed their agreement (delayed alert — signed ${signedAt})`,
        row.property_address,
        `Signed copy went to ${row.recipient_email} — check the email log if in doubt.`,
      ].join("\n"),
    );
    if (!ok) continue;
    await supabase
      .from("agreement_requests")
      .update({ operator_notified_at: new Date().toISOString() })
      .eq("id", row.id);
    sent++;
  }
  return { sent, pending: (rows?.length ?? 0) - sent };
}
