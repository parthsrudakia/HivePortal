import { Resend } from "resend";

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

  if (error) return { ok: false, error: error.message };
  if (!data?.id) return { ok: false, error: "No id returned from Resend" };
  return { ok: true, id: data.id };
}
