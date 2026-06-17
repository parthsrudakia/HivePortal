import { Resend } from "resend";
import { logEmail } from "./email-log";
import { sendGmailMessage } from "./google-mail";

const REMINDER_SUBJECT = "Rent Reminder";

const REMINDER_TEXT = `Hi,

This is a friendly reminder that your rent is due. Please submit payment by the 5th of this month to avoid a $50 late fee. Please ignore if already paid.

Thanks`;

const REMINDER_HTML = `<div style="font-family: 'DM Sans', Arial, sans-serif; color:#1a1a18; max-width:560px; line-height:1.5;">
  <p>Hi,</p>
  <p>This is a friendly reminder that your rent is due. Please submit payment by the <strong>5th of this month</strong> to avoid a <strong>$50 late fee</strong>. Please ignore if already paid.</p>
  <p>Thanks</p>
</div>`;

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

// Plain, unbranded cover message for the Gmail (New York, no-letterhead) draft.
// Deliberately no Hive mention and no HTML — kept as simple as possible.
export function gmailAgreementBody(opts: { tenantName: string }): {
  subject: string;
  text: string;
} {
  const name = opts.tenantName.trim() || "there";
  return {
    subject: "Sublease Agreement",
    text: `Hello ${name},\n\nPlease find attached your Sublease Agreement.`,
  };
}

// Branded cover message for the Outlook (non-NY, with-letterhead) draft. The PDF
// is attached separately; this is just the cover message.
export function agreementEmailTemplate(opts: { tenantName: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const firstName = opts.tenantName.trim().split(/\s+/)[0] || "there";
  const subject = "Your Hive sublease agreement";
  const text = `Hi ${firstName},

Welcome to Hive! Please find your sublease agreement attached. Review it, sign it and send it back. Reply to this email if you have any questions.

Looking forward to having you with us.

Best,
Vineet
Hive`;
  const html = `<div style="margin:0; padding:20px 12px; background:#f5f2ed; font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#fefdfb; border:1px solid #e8e3db; border-radius:16px; overflow:hidden;">
    <div style="height:6px; background:#d4920b;"></div>
    <div style="padding:24px 20px; color:#1a1a18; line-height:1.55; font-size:15px;">
      <p style="margin:0 0 14px;">Hi ${firstName},</p>
      <p style="margin:0 0 14px;">Welcome to Hive! Please find your sublease agreement attached. Review it, sign it and send it back. Reply to this email if you have any questions.</p>
      <p style="margin:0 0 14px;">Looking forward to having you with us.</p>
      <p style="margin:18px 0 0;">Best,<br/>Vineet<br/><span style="color:#8a8378;">Hive</span></p>
    </div>
  </div>
</div>`;
  return { subject, text, html };
}

export async function sendRentReminder(to: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const replyTo = process.env.RESEND_REPLY_TO;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject: REMINDER_SUBJECT,
    text: REMINDER_TEXT,
    html: REMINDER_HTML,
  });

  const result: SendResult = error
    ? { ok: false, error: error.message }
    : data?.id
      ? { ok: true, id: data.id }
      : { ok: false, error: "No id returned from Resend" };
  await logEmail({
    type: "rent_reminder",
    recipient: to,
    subject: REMINDER_SUBJECT,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
}

// ----- New York variants -----
// New York tenants get personal, unbranded correspondence: sent from Vineet's
// personal Gmail (From "Vineet", no Hive mention), plain text only — no HTML.
// The reminder copy below is intentionally identical to the Resend versions,
// which already carry no branding; only the channel and format differ.

export async function sendRentReminderGmail(to: string): Promise<SendResult> {
  const result = await sendGmailMessage({
    to,
    subject: REMINDER_SUBJECT,
    text: REMINDER_TEXT,
  });
  await logEmail({
    type: "rent_reminder",
    recipient: to,
    subject: REMINDER_SUBJECT,
    context: "new_york_gmail",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });
  return result;
}

export async function sendBalanceReminderGmail(
  to: string,
  amountDue: number,
  monthLabel: string,
): Promise<SendResult> {
  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const subject = `Rent balance due — ${monthLabel}`;
  const text = `Hi,

My records show an outstanding rent balance of ${amount} for ${monthLabel}. Please submit payment as soon as possible to avoid a $50 late fee.

Thanks
Vinny`;
  const result = await sendGmailMessage({ to, subject, text });
  await logEmail({
    type: "rent_balance",
    recipient: to,
    subject,
    context: `${monthLabel} · new_york_gmail`,
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
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const replyTo = process.env.RESEND_REPLY_TO;

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

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject,
    text,
    html,
  });

  const result: SendResult = error
    ? { ok: false, error: error.message }
    : data?.id
      ? { ok: true, id: data.id }
      : { ok: false, error: "No id returned from Resend" };
  await logEmail({
    type: "lease_end",
    recipient: to,
    subject,
    context: `${opts.unitLabel} · ${opts.tenantName}`,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
}

// Balance-specific reminder: sent manually to a tenant who still owes rent for
// the month, with the outstanding amount called out. Mobile-first card.
export async function sendBalanceReminder(
  to: string,
  amountDue: number,
  monthLabel: string,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const replyTo = process.env.RESEND_REPLY_TO;

  const amount = `$${Math.round(amountDue).toLocaleString()}`;
  const subject = `Rent balance due — ${monthLabel}`;
  const text = `Hi,

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
      </div>
      <p style="margin:0; font-size:15px; color:#1a1a18; line-height:1.5;">Please submit payment as soon as possible to avoid a <strong>$50 late fee</strong>. If you&rsquo;ve already paid, please disregard this message.</p>
      <p style="margin:16px 0 0; font-size:15px; color:#1a1a18;">Thanks</p>
    </div>
  </div>
</div>`;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject,
    text,
    html,
  });

  const result: SendResult = error
    ? { ok: false, error: error.message }
    : data?.id
      ? { ok: true, id: data.id }
      : { ok: false, error: "No id returned from Resend" };
  await logEmail({
    type: "rent_balance",
    recipient: to,
    subject,
    context: monthLabel,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id : null,
  });
  return result;
}
