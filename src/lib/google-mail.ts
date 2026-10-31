/**
 * Minimal Gmail sender for the personal account (vdutta1485@gmail.com) — used
 * for New York correspondence (agreements + reminders), plain & unbranded,
 * From "Vineet".
 *
 * Sends over SMTP with a Gmail **App Password** (not OAuth) — no consent screen,
 * no token expiry, no redirect dance. Requires 2-Step Verification on the
 * account, then an App Password generated at https://myaccount.google.com/apppasswords.
 *
 * Env: GMAIL_USER (the address), GMAIL_APP_PASSWORD (16-char app password)
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { withSendRetry } from "./send-retry";

// All New York correspondence goes out under this personal identity — display
// name "Vineet", no Hive branding.
function fromHeader(user: string): string {
  return `Vineet <${user}>`;
}

export type DraftInput = {
  to: string;
  /** Hidden recipients. Used by the bulk NY rent-reminder blast: `to` is the
   *  account itself and every tenant goes here so they can't see each other. */
  bcc?: string | string[];
  subject: string;
  /** Optional HTML body. When omitted, a plain text-only message is sent. */
  html?: string;
  text: string;
  /** Optional attachment (PDF, xlsx, …). Omit for a body-only message. */
  attachment?: { filename: string; base64: string; mimeType?: string };
  /** After a successful SMTP handoff, confirm the message is visible in the
   *  account's Sent folder (IMAP, same app password) before reporting success —
   *  parity with the Outlook path. Adds a few seconds per send: enable for
   *  one-off, high-stakes sends (agreements), skip for bulk blasts. */
  verifySent?: boolean;
};

/**
 * Diagnostic breadcrumbs from a verified send, surfaced so the Telegram
 * activity log can capture WHY a send failed or how it was verified — e.g.
 * whether the draft carried an internetMessageId, and how the Sent-folder
 * match resolved. Populated by sendOutlookMessage always, and by
 * sendGmailMessage when verifySent is requested.
 */
export type SendDiag = {
  createStatus?: number;
  /** internetMessageId present on the draft-create response ("" / null if absent). */
  internetMessageIdOnCreate?: string | null;
  sendStatus?: number;
  /** How delivery was confirmed. */
  verifyMethod?:
    | "immutable-id"
    | "subject+recipient+sentDateTime"
    | "imap-message-id";
  verifyAttempts?: number;
  /** Message located in the provider's Sent folder (Sent Items / Sent Mail). */
  matchedInSentItems?: boolean;
  /** How many recent Sent-Items messages matched the subject+time filter. */
  sentItemsCandidates?: number;
  note?: string;
};

export type SendResult =
  | { ok: true; id: string; diag?: SendDiag; attempts?: number }
  | { ok: false; error: string; diag?: SendDiag; attempts?: number };

function config() {
  const user = process.env.GMAIL_USER;
  // Google displays app passwords as "abcd efgh ijkl mnop"; the spaces are
  // cosmetic, so strip all whitespace before authenticating.
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function gmailConfigured(): boolean {
  return config() !== null;
}

function makeTransport(
  cfg: { user: string; pass: string },
  onHandover?: () => void,
) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    // Fail fast instead of hanging into the serverless time budget (nodemailer
    // defaults allow up to 2 minutes just to connect).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    logger: onHandover ? handoverLogger(onHandover) : false,
  });
}

// nodemailer logs `tnx: "send"` once connect, TLS and login are done, just
// before it starts handing the message over (MAIL FROM, RCPT, DATA). Nothing
// else is logged or kept.
function handoverLogger(onHandover: () => void) {
  const ignore = () => {};
  return {
    level: ignore,
    trace: ignore,
    debug: ignore,
    info: (entry: { tnx?: string } | undefined) => {
      if (entry?.tnx === "send") onHandover();
    },
    warn: ignore,
    error: ignore,
    fatal: ignore,
  };
}

// An explicit 4xx means Gmail refused this attempt, so nothing was accepted.
// A refused login (EAUTH, e.g. 535) is never retried: it means the app
// password is dead, and trying again can't fix that. A dropped connection is
// only safe before the hand-over: after it, Gmail may have taken the message
// and just never said so.
const RETRY_SMTP_CODES = new Set([421, 450, 451, 452, 454]);
const RETRY_CONNECTION_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ESOCKET", "ECONNECTION"]);

function retryableGmailError(e: unknown, handedOver: boolean): boolean {
  const { code, responseCode } = (e ?? {}) as { code?: unknown; responseCode?: unknown };
  if (code === "EAUTH") return false;
  if (typeof responseCode === "number") return RETRY_SMTP_CODES.has(responseCode);
  return !handedOver && typeof code === "string" && RETRY_CONNECTION_CODES.has(code);
}

/**
 * Verify the Gmail App Password authenticates over SMTP (i.e. sending will work)
 * WITHOUT sending anything. Used by the Telegram /diag command.
 */
export async function checkGmailAuth(): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
}> {
  const cfg = config();
  if (!cfg) return { configured: false, ok: false };
  try {
    await makeTransport(cfg).verify();
    return { configured: true, ok: true };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Gmail error",
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the account's Sent folder over IMAP (same app password as SMTP) for the
 * Message-ID we just handed to Gmail. Gmail appends SMTP submissions to Sent
 * Mail, usually instantly, so a miss after ~9s of polling is a red flag worth
 * failing on. Distinguishes "verification ran and the message is missing"
 * (ran: true, found: false) from "verification couldn't run at all" — e.g.
 * IMAP disabled on the account — which must not fail an otherwise-good send.
 */
async function findInGmailSent(
  cfg: { user: string; pass: string },
  messageId: string,
): Promise<{ ran: boolean; found: boolean; attempts: number; note?: string }> {
  // IMAP HEADER search matches substrings; the angle brackets around the id
  // can defeat it on some servers, so search on the bare id.
  const needle = messageId.replace(/^</, "").replace(/>$/, "").trim();
  if (!needle) {
    return { ran: false, found: false, attempts: 0, note: "no Message-ID to verify" };
  }
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    socketTimeout: 20_000,
  });
  try {
    await client.connect();
  } catch (e) {
    return {
      ran: false,
      found: false,
      attempts: 0,
      note: `IMAP unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    // Locate the Sent folder by its special-use flag — the display name is
    // per-account localized ("[Gmail]/Sent Mail" only on English accounts).
    const folders = await client.list();
    const sentPath =
      folders.find((f) => f.specialUse === "\\Sent")?.path ?? "[Gmail]/Sent Mail";
    const delays = [0, 1500, 2000, 2500, 3000]; // ~9s budget
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      const lock = await client.getMailboxLock(sentPath);
      try {
        const uids = await client.search(
          { header: { "message-id": needle } },
          { uid: true },
        );
        if (Array.isArray(uids) && uids.length > 0) {
          return { ran: true, found: true, attempts: attempt + 1 };
        }
      } finally {
        lock.release();
      }
    }
    return { ran: true, found: false, attempts: delays.length };
  } catch (e) {
    return {
      ran: false,
      found: false,
      attempts: 0,
      note: `IMAP verify error: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Send a message immediately as the personal account (From "Vineet"). Used for
 * New York agreements and reminders. Plain text by default; multipart with the
 * HTML alternative and/or an attachment when provided. With verifySent, success
 * additionally requires the message to show up in the Sent folder over IMAP.
 */
export async function sendGmailMessage(input: DraftInput): Promise<SendResult> {
  const cfg = config();
  if (!cfg) {
    return {
      ok: false,
      error: "Gmail is not configured (missing GMAIL_USER / GMAIL_APP_PASSWORD).",
    };
  }
  try {
    let handedOver = false;
    const transport = makeTransport(cfg, () => {
      handedOver = true;
    });
    const message = {
      from: fromHeader(cfg.user),
      to: input.to,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachment
        ? [
            {
              filename: input.attachment.filename,
              content: Buffer.from(input.attachment.base64, "base64"),
              contentType: input.attachment.mimeType || "application/pdf",
            },
          ]
        : undefined,
    };
    // Only sendMail is retried; nothing after Gmail's 250 (the recipient
    // check, the Sent-folder check) ever sends again.
    const sent = await withSendRetry(
      () => {
        handedOver = false;
        return transport.sendMail(message);
      },
      { isRetryable: (e) => retryableGmailError(e, handedOver) },
    );
    const attempts = sent.attempts;
    if (!sent.ok) {
      return {
        ok: false,
        error: sent.error instanceof Error ? sent.error.message : "Unknown Gmail error",
        attempts,
      };
    }
    const info = sent.value;
    // SMTP can accept the envelope while refusing individual recipients
    // (mainly on BCC blasts) — surface that instead of reporting a full send.
    const rejected = (info.rejected ?? []).map((r) =>
      typeof r === "string" ? r : r.address,
    );
    if (rejected.length > 0) {
      return {
        ok: false,
        error: `Gmail refused recipient(s): ${rejected.join(", ")}`,
        attempts,
      };
    }
    const messageId = info.messageId || "";
    if (!input.verifySent) {
      return { ok: true, id: messageId, attempts };
    }

    const verify = await findInGmailSent(cfg, messageId);
    const diag: SendDiag = {
      verifyMethod: "imap-message-id",
      verifyAttempts: verify.attempts,
      matchedInSentItems: verify.found,
      ...(verify.note ? { note: verify.note } : {}),
    };
    if (!verify.ran || verify.found) {
      // Found in Sent Mail, or verification infrastructure was unavailable —
      // in the latter case the SMTP 250 stands and the diag says why.
      return { ok: true, id: messageId, diag, attempts };
    }
    return {
      ok: false,
      error:
        "Gmail accepted the message but it did not appear in the Sent folder " +
        "within ~9s — check the Sent folder before retrying so the recipient " +
        "isn't emailed twice.",
      diag,
      attempts,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown Gmail error",
    };
  }
}
