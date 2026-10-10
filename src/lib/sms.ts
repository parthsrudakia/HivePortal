/**
 * SMS sender — Zoom Phone SMS API.
 *
 * Texts go out from a Zoom Phone number that has SMS enabled, authenticated
 * with a Server-to-Server OAuth app. Two-step: mint a short-lived access token
 * (account_credentials grant, Basic-auth client id/secret), then POST the
 * message to /v2/phone/sms/messages.
 *
 * Env:
 *   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET  — the S2S OAuth app
 *   ZOOM_SMS_FROM                                        — sending number, E.164 (+1…)
 *
 * The S2S app needs the `phone_sms:write:admin` scope and the sending number
 * must have SMS enabled in Zoom Phone.
 *
 * NOTE: Zoom's send-SMS request body is documented behind a JS-rendered
 * reference; the payload below matches the published shape (sender +
 * to_members + message). If a 400 comes back, the field names are the first
 * thing to adjust — they're isolated in sendSms() for exactly that reason.
 */

import { logSms, type SmsType } from "./sms-log";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_SMS_URL = "https://api.zoom.us/v2/phone/sms/messages";
const ZOOM_CAMPAIGNS_URL = "https://api.zoom.us/v2/phone/sms_campaigns";

export type SmsResult =
  | { ok: true }
  | { ok: false; skipped?: boolean; error: string };

/** Optional metadata so the send is recorded in sms_log under the right type. */
export type SmsMeta = { type?: SmsType; context?: string | null };

function config() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  const from = process.env.ZOOM_SMS_FROM;
  if (!accountId || !clientId || !clientSecret || !from) return null;
  return { accountId, clientId, clientSecret, from };
}

export function smsConfigured(): boolean {
  return config() !== null;
}

/**
 * Normalize a phone number to a US/Canada (+1) E.164 number, or return null to
 * SKIP it. We only text +1 numbers:
 *   - No "+": assume +1 — bare 10 digits → +1XXXXXXXXXX, 11 digits starting
 *     with 1 → +1…
 *   - Explicit "+1…": kept.
 *   - Any other explicit "+" country code (e.g. +44, +91): null → skipped.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    // An explicit country code is present — only +1 (US/Canada) is allowed;
    // anything else is intentionally skipped.
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// Cache the S2S access token across calls in a warm process (Zoom tokens last
// ~1h); refresh a minute early to avoid edge-of-expiry failures.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("SMS is not configured (missing ZOOM_* env).");

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString(
    "base64",
  );
  const res = await fetch(
    `${ZOOM_TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Zoom token request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Zoom token response had no access_token.");
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

/**
 * Send one SMS. Returns { ok:false } (never throws) so a failed text never
 * blocks the email reminder it accompanies.
 *
 * `to` may be a list of numbers — they become ONE group thread (a single
 * message all recipients share, replies visible to everyone in it).
 */
export async function sendSms(
  to: string | string[],
  body: string,
  meta?: SmsMeta,
): Promise<SmsResult> {
  const recipients = Array.isArray(to) ? to : [to];
  const recipientLabel = recipients.join(", ");
  const type: SmsType = meta?.type ?? "manual";
  const context = meta?.context ?? null;
  const log = (status: "sent" | "failed" | "skipped", error?: string) =>
    logSms({
      type,
      recipient: recipientLabel,
      body,
      status,
      error: error ?? null,
      context,
    });

  const cfg = config();
  if (!cfg) {
    const error = "SMS is not configured (missing ZOOM_* env).";
    await log("failed", error);
    return { ok: false, error };
  }

  const normalized = recipients.map((r) => ({ raw: r, e164: toE164(r) }));
  const invalid = normalized.filter((n) => !n.e164);
  if (invalid.length > 0 && recipients.length === 1) {
    // Not a US/Canada (+1) number — Zoom Phone SMS only reaches +1, so we
    // intentionally skip it (recorded as 'skipped', not a failure).
    const error = `Skipped — not a US/Canada number: ${recipients[0]}`;
    await log("skipped", error);
    return { ok: false, skipped: true, error };
  }
  if (invalid.length > 0) {
    // A group thread missing a member would silently mislead (e.g. the
    // operator thinking they're in the thread) — fail loudly instead.
    const error = `Group text not sent — not US/Canada numbers: ${invalid
      .map((n) => n.raw)
      .join(", ")}`;
    await log("failed", error);
    return { ok: false, error };
  }
  const toNumbers = normalized.map((n) => n.e164 as string);
  // Zoom wants both numbers in E.164; normalize the configured sender too.
  const fromNumber = toE164(cfg.from) ?? cfg.from;

  try {
    const token = await accessToken();
    const res = await fetch(ZOOM_SMS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { phone_number: fromNumber },
        to_members: toNumbers.map((phone_number) => ({ phone_number })),
        message: body,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const error = `Zoom SMS failed (${res.status}): ${detail.slice(0, 200)}`;
      await log("failed", error);
      return { ok: false, error };
    }
    await log("sent");
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown SMS error";
    await log("failed", error);
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Opt-out lookup
//
// Zoom handles STOP/START replies on the 10DLC campaign itself: a tenant who
// texts STOP is blocked by Zoom, and later portal sends to them still return
// 2xx (and log as "sent") but never arrive. This asks Zoom whether a given
// recipient is currently opted in or out for our campaign, so an operator can
// find out why someone "isn't getting the texts".
//
// Endpoint: GET /phone/sms_campaigns/{campaignId}/phone_numbers/opt_status
//   ?zoom_phone_user_numbers=<our sending number>&consumer_phone_number=<theirs>
// Scopes: phone:read:list_sms_campaigns:admin,
//         phone:read:sms_campaign_number_opt_status:admin
// A number Zoom has never heard from comes back "opt_in" (the default).
// ---------------------------------------------------------------------------

export type SmsOptStatus = "opt_in" | "opt_out";

export type SmsOptResult =
  | {
      ok: true;
      /** The recipient, E.164. */
      phone: string;
      status: SmsOptStatus;
      /** True when the recipient replied STOP (or a synonym) and Zoom blocks our texts to them. */
      optedOut: boolean;
      /** Our sending number, E.164. */
      sender: string;
      campaign: { id: string; name: string };
    }
  | { ok: false; skipped?: boolean; error: string };

type ZoomCampaignList = {
  sms_campaigns?: { id: string; status?: string; display_name?: string }[];
};

type ZoomOptStatusResponse = {
  phone_number_campaign_opt_statuses?: {
    consumer_phone_number?: string;
    zoom_phone_user_number?: string;
    opt_status?: string;
  }[];
};

/**
 * Pull the opt status for one sender/recipient pair out of Zoom's response.
 * Exported for tests. Returns null when the pair isn't in the payload.
 */
export function parseOptStatus(
  payload: ZoomOptStatusResponse,
  sender: string,
  recipient: string,
): SmsOptStatus | null {
  // Compare as E.164 so "6095549141", "+16095549141" and "16095549141" agree.
  const norm = (v: string | undefined) => toE164(v) ?? (v ?? "").replace(/\D/g, "");
  const row = (payload.phone_number_campaign_opt_statuses ?? []).find(
    (r) =>
      norm(r.zoom_phone_user_number) === norm(sender) &&
      norm(r.consumer_phone_number) === norm(recipient),
  );
  if (!row) return null;
  return row.opt_status === "opt_out" ? "opt_out" : "opt_in";
}

// The account has one 10DLC campaign; cache it for the life of the process.
let cachedCampaign: { id: string; name: string } | null = null;

async function activeCampaign(token: string): Promise<{ id: string; name: string }> {
  if (cachedCampaign) return cachedCampaign;
  const res = await fetch(ZOOM_CAMPAIGNS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Zoom campaign list failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as ZoomCampaignList;
  const campaigns = data.sms_campaigns ?? [];
  const active = campaigns.find((c) => c.status === "active") ?? campaigns[0];
  if (!active) throw new Error("No SMS campaign is registered on the Zoom account.");
  cachedCampaign = { id: active.id, name: active.display_name ?? active.id };
  return cachedCampaign;
}

/**
 * Ask Zoom whether `raw` (any US/Canada phone format) has opted out of texts
 * from our sending number. Never throws — returns { ok:false } with a reason.
 */
export async function getSmsOptStatus(raw: string): Promise<SmsOptResult> {
  const cfg = config();
  if (!cfg) return { ok: false, error: "SMS is not configured (missing ZOOM_* env)." };

  const phone = toE164(raw);
  if (!phone) {
    return {
      ok: false,
      skipped: true,
      error: `Not a US/Canada number: ${raw.trim() || "(empty)"} — Zoom only texts +1 numbers, so it has no opt status.`,
    };
  }
  const sender = toE164(cfg.from) ?? cfg.from;

  try {
    const token = await accessToken();
    const campaign = await activeCampaign(token);
    const url = new URL(`${ZOOM_CAMPAIGNS_URL}/${encodeURIComponent(campaign.id)}/phone_numbers/opt_status`);
    // Zoom wants bare digits with the country code here (the "+" is optional).
    url.searchParams.set("zoom_phone_user_numbers", sender.replace(/\D/g, ""));
    url.searchParams.set("consumer_phone_number", phone.replace(/\D/g, ""));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Zoom opt-status lookup failed (${res.status}): ${detail.slice(0, 200)}`,
      };
    }
    const payload = (await res.json()) as ZoomOptStatusResponse;
    const status = parseOptStatus(payload, sender, phone);
    if (!status) {
      return { ok: false, error: `Zoom returned no opt status for ${phone}.` };
    }
    return {
      ok: true,
      phone,
      status,
      optedOut: status === "opt_out",
      sender,
      campaign,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown Zoom error" };
  }
}

// ---------------------------------------------------------------------------
// Balance texts: a group thread with the operator
//
// Every balance-reminder text (Rent Tracker button, the bot's
// send_balance_reminders, the month-end cron's owing-tenant texts) goes out as
// ONE group thread: the Zoom sending number, the tenant, and the operator
// (OPERATOR_PHONE, Vineet). The tenant sees the operator's number and every
// reply is visible to all three.
// ---------------------------------------------------------------------------

/**
 * Recipients for a balance text. A tenant number Zoom can't text (non-+1)
 * stays a lone recipient so sendSms records it as skipped, the same as before.
 * Returns an error when OPERATOR_PHONE is unset: a balance text must never go
 * out quietly without the operator in the thread.
 */
export function balanceTextRecipients(
  tenantPhone: string,
): { ok: true; to: string | string[] } | { ok: false; error: string } {
  if (!toE164(tenantPhone)) return { ok: true, to: tenantPhone };
  const operator = process.env.OPERATOR_PHONE?.trim();
  if (!operator) {
    return {
      ok: false,
      error: "OPERATOR_PHONE is not configured, so the balance text can't include the operator.",
    };
  }
  return { ok: true, to: [tenantPhone, operator] };
}

/** Send a balance text to the tenant + operator group thread. Never throws. */
export async function sendBalanceText(
  tenantPhone: string,
  body: string,
  meta: SmsMeta,
): Promise<SmsResult> {
  const r = balanceTextRecipients(tenantPhone);
  if (!r.ok) {
    await logSms({
      type: meta.type ?? "rent_balance",
      recipient: tenantPhone,
      body,
      status: "failed",
      error: r.error,
      context: meta.context ?? null,
    });
    return { ok: false, error: r.error };
  }
  const group = Array.isArray(r.to);
  return sendSms(r.to, body, {
    ...meta,
    context: group ? `${meta.context ?? ""} · group thread + operator`.replace(/^ · /, "") : meta.context,
  });
}
