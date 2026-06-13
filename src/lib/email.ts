import { Resend } from "resend";
import { logEmail } from "./email-log";

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
