/**
 * Mailbox connection alerts. If the NY Gmail account or the Outlook work
 * mailbox can't sign in, every master user (Vineet) gets a blocking login
 * reminder (login_reminders → LoginReminderPopup) until it's fixed; once the
 * mailbox signs in again, its reminder clears itself.
 *
 * Both triggers reuse the Telegram /diag checks:
 *   - runMailboxHealthCheck — the daily cron checks both mailboxes.
 *   - reportMailboxAuthFailure — a real send just failed to sign in, so
 *     recheck that mailbox and alert only if it still fails.
 */

import { after } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isMaster } from "./access";
import { todayISO } from "./date";
import { checkGmailAuth } from "./google-mail";
import { checkOutlookSendAuth } from "./graph-mail";

export type MailboxChannel = "gmail" | "outlook";

export type MailboxStatus =
  | { connected: true; cleared: number }
  | { connected: false; error: string; created: number };

type CheckResult = { configured: boolean; ok: boolean; error?: string };

const CHANNELS: MailboxChannel[] = ["gmail", "outlook"];

const MESSAGES: Record<MailboxChannel, string> = {
  gmail:
    "The NY Gmail account isn't connected (Google is rejecting its app password), so NY agreements and reminders aren't going out. Ask Parth or Amir to reconnect it.",
  outlook:
    "The Outlook work mailbox isn't connected (Microsoft rejected its sign-in), so branded agreements and reminders aren't going out. Ask Parth or Amir to reconnect it.",
};

// A failed check is tried once more after this pause before it raises an
// alert: Gmail intermittently refuses the app password, and a one-off
// refusal shouldn't put a false alarm in front of Vineet.
const RECHECK_DELAY_MS = 3_000;
const REPORT_INTERVAL_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolved per call rather than in a module-level map: google-mail and
// graph-mail import this module too.
function checkMailbox(channel: MailboxChannel): Promise<CheckResult> {
  return channel === "gmail" ? checkGmailAuth() : checkOutlookSendAuth();
}

function connected(result: CheckResult): boolean {
  return result.configured && result.ok;
}

function shortError(result: CheckResult): string {
  if (!result.configured) return "not configured";
  const error = (result.error ?? "unknown error").replace(/\s+/g, " ").trim();
  return error.length > 160 ? `${error.slice(0, 159)}…` : error;
}

async function masterUserIds(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw new Error(error.message);
  return (data?.users ?? []).filter((u) => isMaster(u.email)).map((u) => u.id);
}

/**
 * Bring login_reminders in line with one check result: a failing mailbox has
 * exactly one undismissed reminder per master user, a passing one has none.
 */
async function recordStatus(
  admin: SupabaseClient,
  channel: MailboxChannel,
  result: CheckResult,
): Promise<MailboxStatus> {
  const createdBy = `mailbox-check:${channel}`;
  if (connected(result)) {
    const { data, error } = await admin
      .from("login_reminders")
      .update({ dismissed_at: new Date().toISOString() })
      .eq("created_by", createdBy)
      .is("dismissed_at", null)
      .select("id");
    if (error) throw new Error(error.message);
    return { connected: true, cleared: data?.length ?? 0 };
  }

  const detail = shortError(result);
  const masters = await masterUserIds(admin);
  if (masters.length === 0) return { connected: false, error: detail, created: 0 };
  const { data: open, error: openError } = await admin
    .from("login_reminders")
    .select("user_id")
    .eq("created_by", createdBy)
    .is("dismissed_at", null)
    .in("user_id", masters);
  if (openError) throw new Error(openError.message);
  const alerted = new Set((open ?? []).map((r) => r.user_id));
  const missing = masters.filter((id) => !alerted.has(id));
  if (missing.length > 0) {
    const { error } = await admin.from("login_reminders").insert(
      missing.map((user_id) => ({
        user_id,
        message: `${MESSAGES[channel]} [${detail}]`,
        show_after: todayISO(),
        created_by: createdBy,
      })),
    );
    if (error) throw new Error(error.message);
  }
  return { connected: false, error: detail, created: missing.length };
}

/** Daily check of both mailboxes, run from the notification-followups cron. */
export async function runMailboxHealthCheck(
  admin: SupabaseClient,
): Promise<Record<MailboxChannel, MailboxStatus>> {
  const statuses = await Promise.all(
    CHANNELS.map(async (channel) => {
      let result = await checkMailbox(channel);
      if (!connected(result) && result.configured) {
        await sleep(RECHECK_DELAY_MS);
        result = await checkMailbox(channel);
      }
      return [channel, await recordStatus(admin, channel, result)] as const;
    }),
  );
  return Object.fromEntries(statuses) as Record<MailboxChannel, MailboxStatus>;
}

const lastReported = new Map<MailboxChannel, number>();

/**
 * A real send just failed to sign in. Recheck that mailbox once the response
 * is out (so the failed send isn't held up) and alert only if it still
 * fails; a passing recheck clears any old alert instead. At most once per
 * mailbox per 10 minutes per server instance. Never throws.
 */
export async function reportMailboxAuthFailure(
  channel: MailboxChannel,
): Promise<void> {
  const now = Date.now();
  const last = lastReported.get(channel);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return;
  lastReported.set(channel, now);
  try {
    after(() => recheck(channel));
  } catch {
    // Outside a request (scripts, tests) there's no response to wait for.
    await recheck(channel);
  }
}

async function recheck(channel: MailboxChannel): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    await sleep(RECHECK_DELAY_MS);
    const result = await checkMailbox(channel);
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await recordStatus(admin, channel, result);
  } catch {
    // Best-effort: alerting must never affect sending.
  }
}
