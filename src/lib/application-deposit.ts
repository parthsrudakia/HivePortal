/**
 * After an invited applicant signs their agreement, email them once asking
 * for half the security deposit by Zelle to hold the room. Only agreements
 * that came from an application invite get it.
 *
 * The signing action sends it right after the Telegram alert; the daily ops
 * cron (retryDepositRequestEmails) re-sends any that didn't go out, skipping
 * rows signed in the last 10 minutes so it never races an in-flight signing.
 * The invite's deposit_email_sent_at stamp is what makes it once-only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendGmailMessage, type SendResult } from "@/lib/google-mail";
import { sendOutlookMessage } from "@/lib/graph-mail";
import { logEmail } from "@/lib/email-log";
import { depositRequestEmailTemplate } from "@/lib/email";
import { addTrackingPixel, trackedPlainText } from "@/lib/email-tracking";
import { premisesLabel } from "@/lib/agreement-send";
import { formatUsd } from "@/lib/application-invites";

const IN_FLIGHT_GRACE_MS = 10 * 60_000;

type RequestRow = {
  id: string;
  status: string;
  tenant_name: string;
  recipient_email: string;
  property_address: string;
  room_number: string | null;
  channel: "gmail" | "outlook";
  signed_at: string | null;
  input: { securityDeposit?: string | number } | null;
};

/** Half the agreement's security deposit, formatted ("$925", "$937.50"). */
export function halfDeposit(securityDeposit: string | number | null | undefined): string | null {
  const n = Number(String(securityDeposit ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatUsd(Math.round((n / 2) * 100) / 100);
}

export type DepositEmailResult =
  | { sent: true }
  | { sent: false; reason: "not_invite" | "already_sent" | "not_signed" | "no_deposit" | "send_failed"; error?: string };

/**
 * Send the deposit request for one signed agreement, if it came from an
 * invite and hasn't been sent yet. Never throws.
 */
export async function sendDepositRequestEmail(
  supabase: SupabaseClient,
  requestId: string,
): Promise<DepositEmailResult> {
  const { data: invite } = await supabase
    .from("application_invites")
    .select("id, deposit_email_sent_at")
    .eq("agreement_request_id", requestId)
    .maybeSingle<{ id: string; deposit_email_sent_at: string | null }>();
  if (!invite) return { sent: false, reason: "not_invite" };
  if (invite.deposit_email_sent_at) return { sent: false, reason: "already_sent" };

  const { data: request } = await supabase
    .from("agreement_requests")
    .select("id, status, tenant_name, recipient_email, property_address, room_number, channel, signed_at, input")
    .eq("id", requestId)
    .maybeSingle<RequestRow>();
  if (!request || request.status !== "signed") return { sent: false, reason: "not_signed" };

  const amount = halfDeposit(request.input?.securityDeposit);
  if (!amount) return { sent: false, reason: "no_deposit" };

  const body = depositRequestEmailTemplate({ tenantName: request.tenant_name, halfDeposit: amount });
  let result: SendResult;
  let trackId: string | null = null;
  try {
    if (request.channel === "gmail") {
      const tracked = trackedPlainText(body.text);
      trackId = tracked.trackId;
      result = await sendGmailMessage({
        to: request.recipient_email,
        subject: body.subject,
        text: body.text,
        html: tracked.html,
        verifySent: true,
      });
    } else {
      const tracked = addTrackingPixel(body.html);
      trackId = tracked.trackId;
      result = await sendOutlookMessage({
        to: request.recipient_email,
        subject: body.subject,
        text: body.text,
        html: tracked.html,
      });
    }
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }

  await logEmail({
    type: "application_deposit",
    recipient: request.recipient_email,
    subject: body.subject,
    context: `${request.tenant_name} · ${premisesLabel(request.room_number, request.property_address)} · half deposit ${amount}`,
    channel: request.channel,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
    track_id: result.ok ? trackId : null,
    attempts: result.attempts,
  });
  if (!result.ok) return { sent: false, reason: "send_failed", error: result.error };

  await supabase
    .from("application_invites")
    .update({ deposit_email_sent_at: new Date().toISOString() })
    .eq("id", invite.id)
    .is("deposit_email_sent_at", null);
  return { sent: true };
}

/**
 * Daily sweep: re-send deposit requests that never went out, and mark
 * invites past their 14 days as expired.
 */
export async function retryDepositRequestEmails(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<{ sent: number; pending: number; expired: number; error?: string }> {
  const { data: expiredRows } = await supabase
    .from("application_invites")
    .update({ status: "expired" })
    .eq("status", "sent")
    .is("claimed_at", null)
    .lt("expires_at", now.toISOString())
    .select("id");
  const expired = expiredRows?.length ?? 0;

  const { data: invites, error } = await supabase
    .from("application_invites")
    .select("id, agreement_request_id")
    .eq("status", "used")
    .is("deposit_email_sent_at", null)
    .not("agreement_request_id", "is", null)
    .returns<{ id: string; agreement_request_id: string }[]>();
  if (error) return { sent: 0, pending: 0, expired, error: error.message };
  const ids = (invites ?? []).map((i) => i.agreement_request_id);
  if (ids.length === 0) return { sent: 0, pending: 0, expired };

  const cutoff = new Date(now.getTime() - IN_FLIGHT_GRACE_MS).toISOString();
  const { data: signed, error: reqError } = await supabase
    .from("agreement_requests")
    .select("id")
    .in("id", ids)
    .eq("status", "signed")
    .lt("signed_at", cutoff)
    .returns<{ id: string }[]>();
  if (reqError) return { sent: 0, pending: 0, expired, error: reqError.message };

  let sent = 0;
  for (const row of signed ?? []) {
    const res = await sendDepositRequestEmail(supabase, row.id);
    if (res.sent) sent++;
  }
  return { sent, pending: (signed?.length ?? 0) - sent, expired };
}
