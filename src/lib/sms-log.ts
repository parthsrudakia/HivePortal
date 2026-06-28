import { createClient } from "@supabase/supabase-js";

export type SmsType =
  | "rent_reminder"
  | "rent_balance"
  | "cleaning_reminder"
  | "cleaner_weekly"
  | "cleaner_update"
  | "manual";

export const SMS_TYPE_LABELS: Record<SmsType, string> = {
  rent_reminder: "Rent reminder (monthly)",
  rent_balance: "Rent balance reminder",
  cleaning_reminder: "Cleaning reminder",
  cleaner_weekly: "Cleaner weekly schedule",
  cleaner_update: "Cleaner schedule update",
  manual: "Manual / other",
};

/**
 * Records one outbound SMS in the sms_log table. Uses the service role so it
 * works from any send path (cron, server action, bot) regardless of the
 * caller's session. Best-effort: logging must never break sending, so all
 * failures are swallowed.
 */
export async function logSms(entry: {
  type: SmsType;
  recipient: string;
  body: string;
  status: "sent" | "failed";
  error?: string | null;
  context?: string | null;
}): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await sb.from("sms_log").insert({
      type: entry.type,
      recipient: entry.recipient,
      body: entry.body,
      status: entry.status,
      channel: "zoom",
      error: entry.error ?? null,
      context: entry.context ?? null,
    });
  } catch {
    // Logging is best-effort and must never interfere with SMS delivery.
  }
}
