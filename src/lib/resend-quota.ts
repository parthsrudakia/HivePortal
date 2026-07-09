/**
 * Resend free-tier guard.
 *
 * Resend's free plan allows only so many emails per day (and per month). Every
 * Resend send in the app funnels through {@link sendViaResend}: while we're
 * under both caps it sends immediately; once a cap is hit the email is parked in
 * the email_queue table and the daily cron ({@link flushEmailQueue}) drains the
 * backlog over the following days, always re-respecting the caps. Gmail sends
 * use a separate channel and don't count here.
 *
 * Usage is counted from email_log (channel='resend', status='sent') — the single
 * source of truth for "emails that actually went out". Both the immediate path
 * and the queue-flush path log there on success, so the flush can never push us
 * past the cap.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { logEmail, type EmailType } from "./email-log";
import { todayISO } from "./date";

export const DAILY_CAP = Number(process.env.RESEND_DAILY_CAP) || 90;
export const MONTHLY_CAP = Number(process.env.RESEND_MONTHLY_CAP) || 3000;

export type ResendPayload = {
  to: string | string[];
  /** Hidden recipients. Used by the bulk rent-reminder blast, which sets `to`
   *  to the from-address and puts every tenant here so they can't see each other. */
  bcc?: string | string[];
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
};

export type ResendLogMeta = {
  type: EmailType;
  context?: string | null;
};

export type SendResult =
  | { ok: true; id: string } // sent now
  | { ok: true; queued: true } // deferred — over cap, parked in email_queue
  | { ok: false; error: string };

type DispatchResult = { ok: true; id: string } | { ok: false; error: string };

function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// UTC instant of ET-midnight today / first-of-month. The server runtime TZ is
// pinned to Eastern (src/instrumentation.ts), so a zone-less Date string parses
// as ET and toISOString() gives the correct UTC boundary.
function dayStartISO(): string {
  return new Date(`${todayISO()}T00:00:00`).toISOString();
}
function monthStartISO(): string {
  return new Date(`${todayISO().slice(0, 7)}-01T00:00:00`).toISOString();
}

async function countResendSent(
  sb: SupabaseClient,
  sinceISO: string,
): Promise<number> {
  const { count } = await sb
    .from("email_log")
    .select("id", { count: "exact", head: true })
    .eq("channel", "resend")
    .eq("status", "sent")
    .gte("created_at", sinceISO);
  return count ?? 0;
}

export type ResendUsage = {
  today: number;
  month: number;
  dailyCap: number;
  monthlyCap: number;
};

export async function resendUsage(sb?: SupabaseClient): Promise<ResendUsage> {
  const client = sb ?? admin();
  if (!client) {
    return { today: 0, month: 0, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP };
  }
  const [today, month] = await Promise.all([
    countResendSent(client, dayStartISO()),
    countResendSent(client, monthStartISO()),
  ]);
  return { today, month, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP };
}

function hasHeadroom(u: ResendUsage): boolean {
  return u.today < u.dailyCap && u.month < u.monthlyCap;
}

function recipientOf(payload: ResendPayload): string {
  // For a BCC blast the visible `to` is just the from-address, so log the bcc
  // list instead — that's who actually received it.
  const audience = payload.bcc ?? payload.to;
  return Array.isArray(audience) ? audience.join(", ") : audience;
}

// ── From-address guardrail ───────────────────────────────────────────────────
// Every outbound Resend email must come from the configured sender
// (RESEND_FROM, or Resend's onboarding fallback when unset). No code path in
// this app — a bug, a stale queue row, bot-tool input — can send as anyone
// else. This cannot stop someone holding the raw API key (they'd call
// Resend's API directly); pair it with a domain-restricted `sending_access`
// key in the Resend dashboard so a leaked key is send-only on our domain.

/** Bare lowercase address from either `a@b.com` or `Name <a@b.com>`. */
function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

function fromAllowed(from: string): boolean {
  const configured = process.env.RESEND_FROM || "onboarding@resend.dev";
  return emailOf(from) === emailOf(configured);
}

/** Actually hit the Resend API and log the outcome to email_log. */
async function dispatch(
  payload: ResendPayload,
  meta: ResendLogMeta,
): Promise<DispatchResult> {
  if (!fromAllowed(payload.from)) {
    const error = `Blocked: from address "${payload.from}" is not the configured sender`;
    await logEmail({
      type: meta.type,
      recipient: recipientOf(payload),
      subject: payload.subject,
      context: meta.context ?? null,
      channel: "resend",
      status: "failed",
      error,
    });
    return { ok: false, error };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    await logEmail({
      type: meta.type,
      recipient: recipientOf(payload),
      subject: payload.subject,
      context: meta.context ?? null,
      channel: "resend",
      status: "failed",
      error: "RESEND_API_KEY not set",
    });
    return { ok: false, error: "RESEND_API_KEY not set" };
  }

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: payload.from,
    to: payload.to,
    bcc: payload.bcc,
    replyTo: payload.replyTo,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  const result: DispatchResult = error
    ? { ok: false, error: error.message }
    : data?.id
      ? { ok: true, id: data.id }
      : { ok: false, error: "No id returned from Resend" };

  await logEmail({
    type: meta.type,
    recipient: recipientOf(payload),
    subject: payload.subject,
    context: meta.context ?? null,
    channel: "resend",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
}

async function enqueue(
  sb: SupabaseClient,
  payload: ResendPayload,
  meta: ResendLogMeta,
): Promise<void> {
  const to = Array.isArray(payload.to) ? payload.to : [payload.to];
  const bcc =
    payload.bcc == null
      ? null
      : Array.isArray(payload.bcc)
        ? payload.bcc
        : [payload.bcc];
  // email_queue post-dates the generated Supabase types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (sb as any).from("email_queue").insert({
    type: meta.type,
    to_addrs: to,
    bcc_addrs: bcc,
    from_addr: payload.from,
    reply_to: payload.replyTo ?? null,
    subject: payload.subject,
    text_body: payload.text,
    html_body: payload.html ?? null,
    context: meta.context ?? null,
  });
}

/**
 * Single chokepoint for every Resend email. Sends immediately while under the
 * daily + monthly caps, otherwise parks the email in email_queue for the daily
 * flush. Returns `{ ok: true, queued: true }` when deferred.
 */
export async function sendViaResend(
  payload: ResendPayload,
  meta: ResendLogMeta,
): Promise<SendResult> {
  // A disallowed from-address never sends and never queues — dispatch logs
  // the block to email_log and rejects without touching the Resend API.
  if (!fromAllowed(payload.from)) return dispatch(payload, meta);

  const sb = admin();
  // Without a service-role client we can neither meter nor queue — fail open and
  // just send, so a missing key never silently drops mail.
  if (!sb) return dispatch(payload, meta);

  const usage = await resendUsage(sb);
  if (hasHeadroom(usage)) return dispatch(payload, meta);

  await enqueue(sb, payload, meta);
  return { ok: true, queued: true };
}

const MAX_ATTEMPTS = 5;

type QueueRow = {
  id: string;
  type: string;
  to_addrs: string[];
  bcc_addrs: string[] | null;
  from_addr: string;
  reply_to: string | null;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  context: string | null;
  attempts: number;
};

export type FlushResult = {
  drained: number;
  failed: number;
  backlog: number;
  remainingDaily: number;
};

/**
 * Drain email_queue up to whatever daily/monthly headroom remains. Called from
 * the daily cron. Oldest pending emails go first (FIFO), so deferred mail sends
 * the next day; anything still over budget stays queued for the day after. A row
 * that errors is retried on later runs up to {@link MAX_ATTEMPTS}, then parked
 * as 'failed'.
 */
export async function flushEmailQueue(sb: SupabaseClient): Promise<FlushResult> {
  const usage = await resendUsage(sb);
  const budget = Math.max(
    0,
    Math.min(usage.dailyCap - usage.today, usage.monthlyCap - usage.month),
  );

  let drained = 0;
  let failed = 0;

  if (budget > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (sb as any)
      .from("email_queue")
      .select(
        "id, type, to_addrs, bcc_addrs, from_addr, reply_to, subject, text_body, html_body, context, attempts",
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(budget);

    for (const row of (rows ?? []) as QueueRow[]) {
      const result = await dispatch(
        {
          to: row.to_addrs,
          bcc: row.bcc_addrs ?? undefined,
          from: row.from_addr,
          replyTo: row.reply_to ?? undefined,
          subject: row.subject,
          text: row.text_body ?? "",
          html: row.html_body ?? undefined,
        },
        { type: row.type as EmailType, context: row.context },
      );

      const attempts = row.attempts + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any)
        .from("email_queue")
        .update(
          result.ok
            ? { status: "sent", sent_at: new Date().toISOString() }
            : {
                attempts,
                last_error: result.error,
                status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
              },
        )
        .eq("id", row.id);

      if (result.ok) drained++;
      else failed++;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (sb as any)
    .from("email_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  const after = await resendUsage(sb);
  return {
    drained,
    failed,
    backlog: count ?? 0,
    remainingDaily: Math.max(0, after.dailyCap - after.today),
  };
}
