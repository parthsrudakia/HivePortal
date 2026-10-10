import { createClient } from "@supabase/supabase-js";

export type EmailType =
  | "rent_reminder"
  | "rent_balance"
  | "room_change"
  | "cleaning_moveout"
  | "cleaning_reminder"
  | "cleaner_weekly"
  | "cleaner_update"
  | "lease_end"
  | "agreement"
  | "agreement_signed"
  | "board"
  | "utility_charge"
  | "other_charge"
  | "emergency_contact";

export const EMAIL_TYPE_LABELS: Record<EmailType, string> = {
  rent_reminder: "Rent reminder (monthly)",
  rent_balance: "Rent balance reminder",
  room_change: "Room change notice",
  cleaning_moveout: "Move-out cleaning",
  cleaning_reminder: "Cleaning reminder",
  cleaner_weekly: "Cleaner weekly schedule",
  cleaner_update: "Cleaner schedule update",
  lease_end: "Lease ending (45-day heads-up)",
  agreement: "Sublease agreement",
  agreement_signed: "Signed agreement copy",
  board: "Projects board notification",
  utility_charge: "Utility charge notice",
  other_charge: "Ledger charge notice",
  emergency_contact: "Emergency contact request",
};

/**
 * Records one outbound email in the email_log table. Uses the service role so
 * it works from any send path (cron, server action, route handler) regardless
 * of the caller's session. Best-effort: logging must never break sending, so
 * all failures are swallowed.
 */
export async function logEmail(entry: {
  type: EmailType;
  recipient: string;
  subject: string;
  status: "sent" | "failed";
  /** Which provider sent it. Only Resend sends count against the Resend cap. */
  channel?: "resend" | "gmail" | "outlook";
  error?: string | null;
  context?: string | null;
  resend_id?: string | null;
  /** Open-tracking pixel id embedded in the HTML (see email-tracking.ts). */
  track_id?: string | null;
}): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await sb.from("email_log").insert({
      type: entry.type,
      recipient: entry.recipient,
      subject: entry.subject,
      status: entry.status,
      channel: entry.channel ?? "resend",
      error: entry.error ?? null,
      context: entry.context ?? null,
      resend_id: entry.resend_id ?? null,
      track_id: entry.track_id ?? null,
    });
  } catch {
    // Logging is best-effort and must never interfere with email delivery.
  }
}
