import { logEmail } from "./email-log";
import { sendGmailMessage } from "./google-mail";
import { outlookConfigured, sendOutlookMessage } from "./graph-mail";
import { sendViaResend, type SendResult } from "./resend-quota";
import { formatDate } from "./date";
import type { CleanerCleaning } from "./cleaner-schedule";
import type { BalanceDetail } from "./balance-detail";

export type { SendResult };

// ----------------------------------------------------------------------------
// Cleaner weekly schedule digest + change notice. Both carry only a link to the
// cleaner's live schedule page (which holds the per-unit tenant/leaseholder/
// move-out details); the messages themselves stay short.
// ----------------------------------------------------------------------------

export type CleanerDigest = {
  cleanerName: string | null;
  weekStart: string; // ISO
  weekEnd: string; // ISO
  url: string;
  cleanings: CleanerCleaning[];
};

function weekRange(weekStart: string, weekEnd: string): string {
  return `${formatDate(weekStart)} – ${formatDate(weekEnd)}`;
}

/** Plain-text "schedule updated" notice (used verbatim by the SMS channel). */
export function cleanerUpdateText(d: CleanerDigest): string {
  const hi = d.cleanerName ? `Hi ${d.cleanerName.split(/\s+/)[0]},` : "Hi,";
  return [
    hi,
    "",
    `Your cleaning schedule for this week (${weekRange(d.weekStart, d.weekEnd)}) has been updated.`,
    "",
    `See the latest: ${d.url}`,
    "",
    "Thanks",
  ].join("\n");
}

function ctaButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block; background:#d4920b; color:#fefdfb; text-decoration:none; font-weight:600; font-size:15px; padding:12px 22px; border-radius:999px;">${label}</a>`;
}

/** Debounced "your schedule changed" notice — points to the live page. */
export async function sendCleanerScheduleUpdate(
  to: string,
  d: CleanerDigest,
): Promise<SendResult> {
  const subject = `Schedule updated — week of ${formatDate(d.weekStart)}`;
  const text = cleanerUpdateText(d);
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <span style="display:inline-block; background:#fbeccc; color:#9a6f08; font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; padding:4px 12px; border-radius:999px;">Updated</span>
      <h1 style="margin:14px 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Your schedule changed</h1>
      <p style="margin:0 0 18px; font-size:15px; color:#8a8378;">This week · ${weekRange(d.weekStart, d.weekEnd)}</p>
      <p style="margin:0 0 18px; font-size:15px; color:#1a1a18;">Your cleaning schedule for this week has been updated. Open the link below for the latest.</p>
      <div>${ctaButton(d.url, "View updated schedule")}</div>
    </div>
    <div style="padding:14px 20px; background:#f5f2ed; border-top:1px solid #e8e3db;">
      <p style="margin:0; font-size:12px; color:#8a8378;">Hive Portal · cleaning schedule update.</p>
    </div>
  </div>
</div>`;
  return sendViaResend(
    { to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
    { type: "cleaner_update", context: d.cleanerName ?? to },
  );
}

function resendFrom() {
  return process.env.RESEND_FROM || "onboarding@resend.dev";
}

const REMINDER_SUBJECT = "Rent Reminder";

// Exported so the SMS channel sends the exact same general-reminder copy.
export const REMINDER_TEXT = `Hi,

This is a friendly reminder that your rent is due. Please submit payment by the 5th of this month to avoid a $50 late fee. Please ignore if already paid.

Thanks`;

// Balance-reminder body — identical wording to the Gmail send, reused by the
// SMS channel so texts match emails.
export function balanceReminderText(amountDue: number, monthLabel: string): string {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  return `Hi,

My records show an outstanding rent balance of ${amount} for ${monthLabel}. Please submit payment as soon as possible to avoid a $50 late fee.

Thanks
Vinny`;
}

const REMINDER_HTML = `<div style="font-family: 'DM Sans', Arial, sans-serif; color:#1a1a18; max-width:560px; line-height:1.5;">
  <p>Hi,</p>
  <p>This is a friendly reminder that your rent is due. Please submit payment by the <strong>5th of this month</strong> to avoid a <strong>$50 late fee</strong>. Please ignore if already paid.</p>
  <p>Thanks</p>
</div>`;

// Plain, unbranded cover message for the Gmail (New York, no-letterhead) draft.
// Deliberately no Hive mention and no HTML — kept as simple as possible.
export function gmailAgreementBody(opts: {
  tenantName: string;
  signUrl: string;
}): {
  subject: string;
  text: string;
} {
  const name = opts.tenantName.trim() || "there";
  return {
    subject: "Agreement",
    text: `Hello ${name},

Your agreement is attached. You can review and sign it online here — the link works for 48 hours:

${opts.signUrl}

Once you sign, you'll automatically get a copy of the signed agreement by email.`,
  };
}

// Operator-entered names land inside HTML bodies; neutralize markup so a
// stray "<" (or a pasted rich-text fragment) can't break or script the email.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Branded cover message for the Outlook (non-NY, with-letterhead) send. The PDF
// is attached separately; this is just the cover message.
export function agreementEmailTemplate(opts: {
  tenantName: string;
  signUrl: string;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const firstName = opts.tenantName.trim().split(/\s+/)[0] || "there";
  const subject = "Your Hive agreement";
  const text = `Hi ${firstName},

Welcome to Hive! Your agreement is attached. You can review and sign it online here — the link works for 48 hours:

${opts.signUrl}

Once you sign, you'll automatically get a copy of the signed agreement by email. Reply to this email if you have any questions.

Looking forward to having you with us.

Best,
Vineet
Hive`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px; color:#1a1a18; line-height:1.55; font-size:15px;">
      <p style="margin:0 0 14px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 14px;">Welcome to Hive! Your agreement is attached. Review it, then sign it online — it only takes a minute.</p>
      <div style="margin:0 0 14px;">${ctaButton(opts.signUrl, "Review & sign agreement")}</div>
      <p style="margin:0 0 14px; font-size:13px; color:#8a8378;">The signing link is valid for 48 hours. Once you sign, a copy of the signed agreement will be emailed to you.</p>
      <p style="margin:0 0 14px;">Reply to this email if you have any questions. Looking forward to having you with us.</p>
      <p style="margin:18px 0 0;">Best,<br/>Vineet<br/><span style="color:#8a8378;">Hive</span></p>
    </div>
  </div>
</div>`;
  return { subject, text, html };
}

// Cover messages for the automatic "here's your signed copy" send after the
// tenant signs on /sign/[token]. Same channel split as the original send.

/** NY variant: personal Gmail, plain text, no Hive mention. */
export function gmailSignedAgreementBody(opts: { tenantName: string }): {
  subject: string;
  text: string;
} {
  const name = opts.tenantName.trim() || "there";
  return {
    subject: "Signed agreement",
    text: `Hello ${name},

Thanks for signing! Your signed agreement is attached — keep it for your records.`,
  };
}

/** Non-NY variant: branded card sent from the Outlook work account. */
export function signedAgreementEmailTemplate(opts: { tenantName: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const firstName = opts.tenantName.trim().split(/\s+/)[0] || "there";
  const subject = "Your signed Hive agreement";
  const text = `Hi ${firstName},

Thanks for signing! Your signed agreement is attached — keep it for your records.

Welcome to Hive — we're looking forward to having you with us.

Best,
Vineet
Hive`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px; color:#1a1a18; line-height:1.55; font-size:15px;">
      <span style="display:inline-block; background:#fbeccc; color:#9a6f08; font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; padding:4px 12px; border-radius:999px;">Signed</span>
      <p style="margin:14px 0 14px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 14px;">Thanks for signing! Your signed agreement is attached &mdash; keep it for your records.</p>
      <p style="margin:0 0 14px;">Welcome to Hive &mdash; we&rsquo;re looking forward to having you with us.</p>
      <p style="margin:18px 0 0;">Best,<br/>Vineet<br/><span style="color:#8a8378;">Hive</span></p>
    </div>
  </div>
</div>`;
  return { subject, text, html };
}

// Plain, unbranded cover message for emailing the public inventory "Shareable
// Sheet". The .xlsx is attached separately; this is just the cover note. Sent
// from the personal Gmail, so NO Hive branding or name anywhere — plain text
// only, no HTML.
export function inventorySheetEmailTemplate(opts: { roomCount: number }): {
  subject: string;
  text: string;
} {
  const n = opts.roomCount;
  const roomsLabel = `${n} room${n === 1 ? "" : "s"}`;
  const subject = "Current room availability";
  const text = `Hi,

Attached is the current list of available rooms (${roomsLabel}), including neighborhood, pricing, availability and amenities. Reply to this email if anything looks like a fit and we'll set up a viewing.

Best,
Vineet`;
  return { subject, text };
}

// ----------------------------------------------------------------------------
// Bulk BCC rent reminders. The general monthly reminder carries no per-tenant
// detail (no name, no amount), so instead of one email per tenant we send a
// single BCC blast per channel — one Resend email for non-NY tenants, one Gmail
// email for NY. Recipients go in BCC so they never see each other. Providers
// cap recipients per message, so the lists are chunked; at current roster size
// each channel is a single send.
// ----------------------------------------------------------------------------

/** Aggregate outcome of a bulk send, counted by recipient. */
export type BulkSendResult = {
  attempted: number;
  sent: number; // recipients whose chunk went out immediately
  queued: number; // recipients whose chunk was parked over the Resend cap
  failed: number; // recipients whose chunk errored
  errors: string[];
};

// Resend caps a single send at 50 recipients (to+cc+bcc); Gmail SMTP tolerates
// ~100 per message. Stay comfortably under both.
const RESEND_BCC_CHUNK = 50;
const GMAIL_BCC_CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One Resend email per ≤50-recipient chunk, tenants in BCC (non-NY roster). */
export async function sendRentReminderBulk(
  recipients: string[],
): Promise<BulkSendResult> {
  const res: BulkSendResult = {
    attempted: recipients.length,
    sent: 0,
    queued: 0,
    failed: 0,
    errors: [],
  };
  for (const group of chunk(recipients, RESEND_BCC_CHUNK)) {
    const r = await sendViaResend(
      {
        to: resendFrom(), // visible recipient is us; tenants are hidden in bcc
        bcc: group,
        from: resendFrom(),
        replyTo: process.env.RESEND_REPLY_TO,
        subject: REMINDER_SUBJECT,
        text: REMINDER_TEXT,
        html: REMINDER_HTML,
      },
      { type: "rent_reminder" },
    );
    if (!r.ok) {
      res.failed += group.length;
      res.errors.push(r.error);
    } else if ("queued" in r) {
      res.queued += group.length;
    } else {
      res.sent += group.length;
    }
  }
  return res;
}

// Branded general-reminder card for the Outlook (work account, non-NY) blast —
// same visual system as the balance-reminder card.
const REMINDER_HTML_BRANDED = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <h1 style="margin:0 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Rent reminder</h1>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18; line-height:1.5;">This is a friendly reminder that your rent is due. Please submit payment by the <strong>5th of this month</strong> to avoid a <strong>$50 late fee</strong>. Please ignore if already paid.</p>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18;">Thanks</p>
    </div>
  </div>
</div>`;

const OUTLOOK_BCC_CHUNK = 90;

/** One Outlook email per ≤90-recipient chunk, non-NY tenants in BCC. Branded
 *  card, sent from the work account. Falls back to the Resend blast when the
 *  Outlook mailbox isn't configured. */
export async function sendRentReminderOutlookBulk(
  recipients: string[],
): Promise<BulkSendResult> {
  if (!outlookConfigured()) return sendRentReminderBulk(recipients);
  const res: BulkSendResult = {
    attempted: recipients.length,
    sent: 0,
    queued: 0,
    failed: 0,
    errors: [],
  };
  for (const group of chunk(recipients, OUTLOOK_BCC_CHUNK)) {
    const result = await sendOutlookMessage({
      to: "",
      bcc: group,
      subject: REMINDER_SUBJECT,
      text: REMINDER_TEXT,
      html: REMINDER_HTML_BRANDED,
    });
    await logEmail({
      type: "rent_reminder",
      recipient: group.join(", "),
      subject: REMINDER_SUBJECT,
      context: "outlook_bulk",
      channel: "outlook",
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error,
      resend_id: null,
    });
    if (!result.ok) {
      res.failed += group.length;
      res.errors.push(result.error);
    } else {
      res.sent += group.length;
    }
  }
  return res;
}

// ----- New York variants -----
// New York tenants get personal, unbranded correspondence: sent from Vineet's
// personal Gmail (From "Vineet", no Hive mention), plain text only — no HTML.
// The reminder copy below is intentionally identical to the Resend versions,
// which already carry no branding; only the channel and format differ.

/** One Gmail email per ≤90-recipient chunk, NY tenants in BCC. Unbranded, from
 *  "Vineet", `to` the account itself. Each chunk logs one email_log row. */
export async function sendRentReminderGmailBulk(
  recipients: string[],
): Promise<BulkSendResult> {
  const res: BulkSendResult = {
    attempted: recipients.length,
    sent: 0,
    queued: 0,
    failed: 0,
    errors: [],
  };
  for (const group of chunk(recipients, GMAIL_BCC_CHUNK)) {
    const result = await sendGmailMessage({
      to: process.env.GMAIL_USER ?? "",
      bcc: group,
      subject: REMINDER_SUBJECT,
      text: REMINDER_TEXT,
    });
    await logEmail({
      type: "rent_reminder",
      recipient: group.join(", "),
      subject: REMINDER_SUBJECT,
      context: "new_york_gmail",
      channel: "gmail",
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error,
      resend_id: result.ok ? result.id || null : null,
    });
    if (!result.ok) {
      res.failed += group.length;
      res.errors.push(result.error);
    } else {
      res.sent += group.length;
    }
  }
  return res;
}

// ----------------------------------------------------------------------------
// Balance-reminder breakdown — the "mini ledger". Every line of the tenant's
// open balance (built by buildBalanceDetail) rendered for email, plus signed
// links to any utility statement behind an overcharge in that window. The SMS
// channel deliberately stays on the short balanceReminderText copy.
// ----------------------------------------------------------------------------

// Ledger lines are cent-precision; show cents only when they exist.
function fmtLedgerAmount(n: number): string {
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Plain-text breakdown, shared by the Resend text part and the Gmail body. */
function balanceBreakdownText(detail: BalanceDetail, amountDue: number): string {
  const lines: string[] = ["Here's what makes up this balance:", ""];
  if (detail.broughtForward !== null) {
    lines.push(`  Balance brought forward: ${fmtLedgerAmount(detail.broughtForward)}`);
  }
  for (const l of detail.lines) {
    const amount =
      l.charge > 0
        ? fmtLedgerAmount(l.charge)
        : `-${fmtLedgerAmount(l.payment)}`;
    lines.push(`  ${formatDate(l.date)}  ${l.description}: ${amount}`);
  }
  lines.push(`  Total due: ${fmtLedgerAmount(amountDue)}`);
  if (detail.utilityLinks.length > 0) {
    lines.push("");
    lines.push(
      detail.utilityLinks.length === 1
        ? "This balance includes a utility charge — the statement is here:"
        : "This balance includes utility charges — the statements are here:",
    );
    for (const u of detail.utilityLinks) lines.push(`  ${u.label}: ${u.url}`);
  }
  return lines.join("\n");
}

/** Branded HTML breakdown table + statement links for the Resend send. */
function balanceBreakdownHtml(detail: BalanceDetail, amountDue: number): string {
  const row = (date: string, desc: string, amount: string, color: string) =>
    `<tr>
      <td style="padding:7px 0; font-size:13px; color:#8a8378; white-space:nowrap; vertical-align:top;">${date}</td>
      <td style="padding:7px 10px; font-size:14px; color:#1a1a18;">${escapeHtml(desc)}</td>
      <td style="padding:7px 0; font-size:14px; color:${color}; text-align:right; white-space:nowrap; vertical-align:top;">${amount}</td>
    </tr>`;

  const rows: string[] = [];
  if (detail.broughtForward !== null) {
    rows.push(
      row("", "Balance brought forward", fmtLedgerAmount(detail.broughtForward), "#1a1a18"),
    );
  }
  for (const l of detail.lines) {
    rows.push(
      l.charge > 0
        ? row(formatDate(l.date), l.description, fmtLedgerAmount(l.charge), "#1a1a18")
        : row(formatDate(l.date), l.description, `−${fmtLedgerAmount(l.payment)}`, "#1e7d3c"),
    );
  }

  const links =
    detail.utilityLinks.length > 0
      ? `<p style="margin:16px 0 0; font-size:14px; color:#1a1a18; line-height:1.5;">
          ${detail.utilityLinks.length === 1 ? "This balance includes a utility charge — you can view the statement here:" : "This balance includes utility charges — you can view the statements here:"}
        </p>
        ${detail.utilityLinks
          .map(
            (u) =>
              `<p style="margin:8px 0 0;"><a href="${u.url}" style="font-size:14px; color:#9a6f08; font-weight:600;">${escapeHtml(u.label)} →</a></p>`,
          )
          .join("")}`
      : "";

  return `<div style="margin:20px 0 0;">
    <p style="margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">What this balance covers</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; border-top:1px solid #e8e3db;">
      ${rows.join("")}
      <tr>
        <td style="padding:9px 0 0; border-top:1px solid #e8e3db;"></td>
        <td style="padding:9px 10px 0; border-top:1px solid #e8e3db; font-size:14px; font-weight:600; color:#1a1a18;">Total due</td>
        <td style="padding:9px 0 0; border-top:1px solid #e8e3db; font-size:14px; font-weight:600; color:#1a1a18; text-align:right;">${fmtLedgerAmount(amountDue)}</td>
      </tr>
    </table>
    ${links}
  </div>`;
}

/** The NY (personal Gmail, unbranded, plain-text) balance-reminder body. */
export function balanceReminderGmailEmail(
  amountDue: number,
  monthLabel: string,
  detail?: BalanceDetail,
): { subject: string; text: string } {
  const subject = `Rent balance due — ${monthLabel}`;
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const text = detail
    ? `Hi,

My records show an outstanding balance of ${amount} as of ${monthLabel}.

${balanceBreakdownText(detail, amountDue)}

Please submit payment as soon as possible to avoid a $50 late fee.

Thanks
Vinny`
    : balanceReminderText(amountDue, monthLabel);
  return { subject, text };
}

export async function sendBalanceReminderGmail(
  to: string,
  amountDue: number,
  monthLabel: string,
  detail?: BalanceDetail,
): Promise<SendResult> {
  const { subject, text } = balanceReminderGmailEmail(
    amountDue,
    monthLabel,
    detail,
  );
  const result = await sendGmailMessage({ to, subject, text });
  await logEmail({
    type: "rent_balance",
    recipient: to,
    subject,
    context: `${monthLabel} · new_york_gmail`,
    channel: "gmail",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });
  return result;
}

// ----------------------------------------------------------------------------
// Utility-charge notice: sent to a tenant the moment their share of a unit's
// over-allowance utility bill is posted to their ledger, asking them to add
// it to next month's rent. Branded via Resend for non-NY; plain unbranded
// Gmail for NY.
// ----------------------------------------------------------------------------

export type UtilityChargeNotice = {
  /** Their share, e.g. 43.75 */
  amount: number;
  /** e.g. "June 2026 · electric (ConEd)" */
  period: string;
  unitLabel: string;
  /** The rent month to include it with, e.g. "August" */
  nextMonthLabel: string;
  /** Signed link to the original bill statement, when available. */
  statementUrl: string | null;
};

function utilityChargeText(n: UtilityChargeNotice, signoff: string): string {
  const amount = `$${n.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `Hi,

Your unit's utility usage went over the monthly allowance, and your share of the bill comes to ${amount}* (${n.period}, ${n.unitLabel}). This has been added to your account.

Please include it with your ${n.nextMonthLabel} rent payment.${
    n.statementUrl ? `\n\nYou can see the bill here: ${n.statementUrl}` : ""
  }

* The utility overage is divided among the tenants with AC in their room.

${signoff}`;
}

export async function sendUtilityChargeNotice(
  to: string,
  n: UtilityChargeNotice,
): Promise<SendResult> {
  const amount = `$${n.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const subject = `Utility charge — please include with your ${n.nextMonthLabel} rent`;
  const text = utilityChargeText(n, "Thanks");
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <h1 style="margin:0 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Utility charge</h1>
      <p style="margin:0; font-size:15px; color:#8a8378;">${escapeHtml(n.period)} · ${escapeHtml(n.unitLabel)}</p>
      <div style="margin:20px 0; background:#f5f2ed; border-radius:12px; padding:16px 18px;">
        <p style="margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">Your share</p>
        <p style="margin:4px 0 0; font-size:24px; font-weight:600; color:#1a1a18;">${amount}*</p>
      </div>
      <p style="margin:0; font-size:15px; color:#1a1a18; line-height:1.5;">Your unit&rsquo;s utility usage went over the monthly allowance, and this is your share of the bill. It has been added to your account &mdash; please include it with your <strong>${escapeHtml(n.nextMonthLabel)} rent payment</strong>.</p>
      ${n.statementUrl ? `<p style="margin:16px 0 0;"><a href="${n.statementUrl}" style="font-size:14px; color:#9a6f08; font-weight:600;">View the bill statement →</a></p>` : ""}
      <p style="margin:16px 0 0; font-size:13px; color:#8a8378;">* The utility overage is divided among the tenants with AC in their room.</p>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18;">Thanks</p>
    </div>
  </div>
</div>`;
  return sendViaResend(
    { to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
    { type: "utility_charge", context: `${n.unitLabel} · ${n.period}` },
  );
}

export async function sendUtilityChargeNoticeGmail(
  to: string,
  n: UtilityChargeNotice,
): Promise<SendResult> {
  const subject = `Utility charge — please include with your ${n.nextMonthLabel} rent`;
  const text = utilityChargeText(n, "Thanks\nVinny");
  const result = await sendGmailMessage({ to, subject, text });
  await logEmail({
    type: "utility_charge",
    recipient: to,
    subject,
    context: `${n.unitLabel} · ${n.period} · new_york_gmail`,
    channel: "gmail",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });
  return result;
}

// Internal heads-up to the operator that a tenant's lease is ending soon (45
// days out by default). Not sent to the tenant.
export async function sendLeaseEndReminder(
  to: string,
  opts: {
    tenantName: string;
    unitLabel: string;
    endDate: string; // ISO "YYYY-MM-DD"
    daysUntil: number;
  },
): Promise<SendResult> {
  const prettyEnd = (() => {
    const d = new Date(opts.endDate + "T00:00:00");
    if (Number.isNaN(d.getTime())) return opts.endDate;
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  })();

  const subject = `Lease ending in ${opts.daysUntil} days — ${opts.tenantName}`;
  const text = `Heads-up:

${opts.tenantName}'s tenancy at ${opts.unitLabel} is ending in ${opts.daysUntil} days, on ${prettyEnd}.

— Hive Portal`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <span style="display:inline-block; background:#fbeccc; color:#9a6f08; font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; padding:4px 12px; border-radius:999px;">Lease ending</span>
      <h1 style="margin:14px 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">${opts.tenantName}</h1>
      <p style="margin:0; font-size:15px; color:#8a8378;">${opts.unitLabel}</p>
      <div style="margin:20px 0; background:#f5f2ed; border-radius:12px; padding:16px 18px;">
        <p style="margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">Lease ends</p>
        <p style="margin:4px 0 0; font-size:20px; font-weight:600; color:#1a1a18;">${prettyEnd}</p>
        <p style="margin:6px 0 0; font-size:13px; color:#8a8378;">In ${opts.daysUntil} days.</p>
      </div>
    </div>
  </div>
</div>`;

  return sendViaResend(
    { to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
    { type: "lease_end", context: `${opts.unitLabel} · ${opts.tenantName}` },
  );
}

// Balance-specific reminder: sent manually to a tenant who still owes rent for
// the month, with the outstanding amount called out. Mobile-first card. When a
// BalanceDetail is provided the card carries the mini ledger (and statement
// links) so the tenant can see exactly what the balance is for.
export function balanceReminderEmail(
  amountDue: number,
  monthLabel: string,
  detail?: BalanceDetail,
): { subject: string; text: string; html: string } {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const subject = `Rent balance due — ${monthLabel}`;
  const text = detail
    ? `Hi,

Our records show an outstanding balance of ${amount} as of ${monthLabel}.

${balanceBreakdownText(detail, amountDue)}

Please submit payment as soon as possible to avoid a $50 late fee. If you've already paid, please disregard this message.

Thanks`
    : `Hi,

Our records show an outstanding rent balance of ${amount} for ${monthLabel}. Please submit payment as soon as possible to avoid a $50 late fee. If you've already paid, please disregard this message.

Thanks`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <h1 style="margin:0 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Rent reminder</h1>
      <p style="margin:0; font-size:15px; color:#8a8378;">${monthLabel}</p>
      <div style="margin:20px 0; background:#f5f2ed; border-radius:12px; padding:16px 18px;">
        <p style="margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">Outstanding balance</p>
        <p style="margin:4px 0 0; font-size:24px; font-weight:600; color:#1a1a18;">${amount}</p>
      </div>${detail ? balanceBreakdownHtml(detail, amountDue) : ""}
      <p style="margin:20px 0 0; font-size:15px; color:#1a1a18; line-height:1.5;">Please submit payment as soon as possible to avoid a <strong>$50 late fee</strong>. If you&rsquo;ve already paid, please disregard this message.</p>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18;">Thanks</p>
    </div>
  </div>
</div>`;

  return { subject, text, html };
}

export async function sendBalanceReminder(
  to: string,
  amountDue: number,
  monthLabel: string,
  detail?: BalanceDetail,
): Promise<SendResult> {
  const { subject, text, html } = balanceReminderEmail(
    amountDue,
    monthLabel,
    detail,
  );
  return sendViaResend(
    { to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
    { type: "rent_balance", context: monthLabel },
  );
}

/** The non-NY balance reminder: branded card via the Outlook work account.
 *  Falls back to the Resend send when Outlook isn't configured. */
export async function sendBalanceReminderOutlook(
  to: string,
  amountDue: number,
  monthLabel: string,
  detail?: BalanceDetail,
): Promise<SendResult> {
  if (!outlookConfigured())
    return sendBalanceReminder(to, amountDue, monthLabel, detail);
  const { subject, text, html } = balanceReminderEmail(
    amountDue,
    monthLabel,
    detail,
  );
  const result = await sendOutlookMessage({ to, subject, text, html });
  await logEmail({
    type: "rent_balance",
    recipient: to,
    subject,
    context: `${monthLabel} · outlook`,
    channel: "outlook",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: null,
  });
  return result;
}

// ----------------------------------------------------------------------------
// Month-end balance + rent reminder — replaces the generic blast for tenants
// who reach the end of the month still owing. One email per tenant: next
// month's rent is due AND here's your outstanding balance (mini ledger) —
// send both together. Branded card via Outlook for non-NY; plain unbranded
// Gmail for NY. The SMS channel uses the short text version.
// ----------------------------------------------------------------------------

export function monthEndBalanceText(amountDue: number): string {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  return `Hi,

This is a friendly reminder that your rent is due. Our records also show an outstanding balance of ${amount} on your account — please include it along with your rent payment by the 5th to avoid a $50 late fee.

Thanks`;
}

export function monthEndBalanceEmail(
  amountDue: number,
  monthLabel: string,
  nextMonthLabel: string,
  detail?: BalanceDetail,
): { subject: string; text: string; html: string } {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const subject = `Rent reminder — please include your ${amount} balance`;
  const breakdown = detail ? `\n${balanceBreakdownText(detail, amountDue)}\n` : "";
  const text = `Hi,

This is a friendly reminder that your ${nextMonthLabel} rent is due. Our records also show an outstanding balance of ${amount} on your account as of ${monthLabel}.
${breakdown}
Please include this balance along with your ${nextMonthLabel} rent payment, by the 5th, to avoid a $50 late fee. If you've already taken care of it, please disregard this message.

Thanks`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px;">
      <h1 style="margin:0 0 4px; font-size:22px; line-height:1.25; color:#1a1a18; font-weight:600;">Rent reminder</h1>
      <p style="margin:0; font-size:15px; color:#8a8378;">${escapeHtml(nextMonthLabel)} rent · outstanding balance</p>
      <div style="margin:20px 0; background:#f5f2ed; border-radius:12px; padding:16px 18px;">
        <p style="margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8378;">Outstanding balance</p>
        <p style="margin:4px 0 0; font-size:24px; font-weight:600; color:#1a1a18;">${amount}</p>
      </div>${detail ? balanceBreakdownHtml(detail, amountDue) : ""}
      <p style="margin:20px 0 0; font-size:15px; color:#1a1a18; line-height:1.5;">Your <strong>${escapeHtml(nextMonthLabel)} rent</strong> is due — please include the balance above along with your rent payment, by the <strong>5th</strong>, to avoid a <strong>$50 late fee</strong>. If you&rsquo;ve already taken care of it, please disregard this message.</p>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18;">Thanks</p>
    </div>
  </div>
</div>`;
  return { subject, text, html };
}

export async function sendMonthEndBalanceReminderOutlook(
  to: string,
  amountDue: number,
  monthLabel: string,
  nextMonthLabel: string,
  detail?: BalanceDetail,
): Promise<SendResult> {
  const { subject, text, html } = monthEndBalanceEmail(
    amountDue,
    monthLabel,
    nextMonthLabel,
    detail,
  );
  if (!outlookConfigured()) {
    return sendViaResend(
      { to, from: resendFrom(), replyTo: process.env.RESEND_REPLY_TO, subject, text, html },
      { type: "rent_reminder", context: `${monthLabel} · month_end_balance` },
    );
  }
  const result = await sendOutlookMessage({ to, subject, text, html });
  await logEmail({
    type: "rent_reminder",
    recipient: to,
    subject,
    context: `${monthLabel} · month_end_balance · outlook`,
    channel: "outlook",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: null,
  });
  return result;
}

export async function sendMonthEndBalanceReminderGmail(
  to: string,
  amountDue: number,
  monthLabel: string,
  nextMonthLabel: string,
  detail?: BalanceDetail,
): Promise<SendResult> {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const subject = `Rent reminder — please include your ${amount} balance`;
  const breakdown = detail ? `\n${balanceBreakdownText(detail, amountDue)}\n` : "";
  const text = `Hi,

This is a friendly reminder that your ${nextMonthLabel} rent is due. My records also show an outstanding balance of ${amount} on your account as of ${monthLabel}.
${breakdown}
Please include this balance along with your ${nextMonthLabel} rent payment, by the 5th, to avoid a $50 late fee. If you've already taken care of it, please disregard this message.

Thanks
Vinny`;
  const result = await sendGmailMessage({ to, subject, text });
  await logEmail({
    type: "rent_reminder",
    recipient: to,
    subject,
    context: `${monthLabel} · month_end_balance · new_york_gmail`,
    channel: "gmail",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });
  return result;
}
