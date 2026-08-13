/**
 * Shared agreement send/resend path: generates the operator-signed PDF, stores
 * it, records an agreement_requests row (the signing tally), and emails the
 * tenant the attachment plus a 48-hour signing link.
 *
 * Service-role throughout so the same code runs from the Telegram webhook,
 * server actions, and the public signing page's follow-ups.
 */

import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  generateAgreementPdf,
  agreementPdfFilename,
  type AgreementInput,
} from "@/lib/agreements";
import { sendGmailMessage } from "@/lib/google-mail";
import { sendOutlookMessage } from "@/lib/graph-mail";
import { agreementEmailTemplate, gmailAgreementBody } from "@/lib/email";
import { logEmail } from "@/lib/email-log";

export const AGREEMENTS_BUCKET = "agreements";
export const OPERATOR_SIGNATURE_PATH = "operator/signature.png";
const SIGN_LINK_HOURS = 48;

export function agreementsAdmin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Neutral origin for signing links (SIGN_ORIGIN), e.g. a no-brand
 *  *.vercel.app alias of this app. Null when unconfigured. */
export function signOrigin(): string | null {
  const raw = process.env.SIGN_ORIGIN?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function signPageUrl(token: string): string {
  // Prefer the neutral domain everywhere; the portal domain contains
  // "hive-portal", which NY emails must never expose (see the guard below).
  const origin =
    signOrigin() ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://hive-portal-1485.vercel.app";
  return `${origin}/sign/${token}`;
}

const NY_SIGN_ORIGIN_ERROR =
  "SIGN_ORIGIN is not configured — New York agreements can't include a signing " +
  "link until a neutral (non-Hive) domain is set, because the portal's own " +
  'domain contains "hive-portal". Set SIGN_ORIGIN and retry.';

/** The operator's signature PNG as a data URL, or null if never captured. */
export async function loadOperatorSignature(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .download(OPERATOR_SIGNATURE_PATH);
  if (!data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export type AgreementSendInput = AgreementInput & {
  recipientEmail: string;
  /** Picks the mailbox and branding: NY → plain Gmail, else branded Outlook. */
  inNewYork: boolean;
  propertyId?: string;
};

export type AgreementSendResult =
  | { ok: true; requestId: string; mailbox: "gmail" | "outlook"; diag?: unknown }
  | { ok: false; error: string; diag?: unknown };

type RequestRow = {
  id: string;
  token: string;
  status: string;
  tenant_name: string;
  recipient_email: string;
  property_address: string;
  include_letterhead: boolean;
  channel: "gmail" | "outlook";
  input: AgreementInput;
  unsigned_pdf_path: string;
  expires_at: string;
};

async function deliverAgreementEmail(opts: {
  channel: "gmail" | "outlook";
  recipient: string;
  tenantName: string;
  propertyAddress: string;
  attachment: { filename: string; base64: string; mimeType: string };
  signUrl: string;
}): Promise<
  | { ok: true; id?: string; diag?: unknown }
  | { ok: false; error: string; diag?: unknown }
> {
  let result;
  let subject: string;
  if (opts.channel === "gmail") {
    // New York: plain, unbranded email from the personal Gmail.
    const body = gmailAgreementBody({
      tenantName: opts.tenantName,
      signUrl: opts.signUrl,
    });
    subject = body.subject;
    result = await sendGmailMessage({
      to: opts.recipient,
      subject: body.subject,
      text: body.text,
      attachment: opts.attachment,
      // Agreements are one-off and high-stakes: require the message to show
      // up in the Gmail Sent folder before reporting success.
      verifySent: true,
    });
  } else {
    const body = agreementEmailTemplate({
      tenantName: opts.tenantName,
      signUrl: opts.signUrl,
    });
    subject = body.subject;
    result = await sendOutlookMessage({
      to: opts.recipient,
      subject: body.subject,
      text: body.text,
      html: body.html,
      attachment: opts.attachment,
    });
  }

  await logEmail({
    type: "agreement",
    recipient: opts.recipient,
    subject,
    context: `${opts.tenantName} · ${opts.propertyAddress}`,
    channel: opts.channel,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });
  return result;
}

/**
 * Generate, store, record, and email an agreement with a signing link.
 * Fails without side effects: a failed email deletes the request row and the
 * stored PDF so the tally never shows a send that didn't happen.
 */
export async function sendAgreementRequest(
  input: AgreementSendInput,
): Promise<AgreementSendResult> {
  const supabase = agreementsAdmin();

  // A send that dies before deliverAgreementEmail would otherwise leave no
  // trace outside the caller's chat/UI — log it so /settings email log shows
  // every attempted agreement send, not just ones that reached the mailbox.
  const logPreEmailFailure = (error: string) =>
    logEmail({
      type: "agreement",
      recipient: input.recipientEmail,
      subject: "Sublease agreement (send failed before email)",
      context: `${input.tenantName} · ${input.propertyAddress}`,
      channel: input.inNewYork ? "gmail" : "outlook",
      status: "failed",
      error,
    });

  // NY correspondence must stay free of Hive branding, including the link's
  // domain — refuse rather than fall back to the hive-portal URL.
  if (input.inNewYork && !signOrigin()) {
    await logPreEmailFailure(NY_SIGN_ORIGIN_ERROR);
    return { ok: false, error: NY_SIGN_ORIGIN_ERROR };
  }

  const sublessorSignature = await loadOperatorSignature(supabase);
  if (!sublessorSignature) {
    const error =
      "No operator signature on file — draw your signature on the portal's Agreements page first.";
    await logPreEmailFailure(error);
    return { ok: false, error };
  }

  const agreementInput: AgreementInput = {
    tenantName: input.tenantName,
    sublessorName: input.sublessorName,
    propertyAddress: input.propertyAddress,
    rent: input.rent,
    securityDeposit: input.securityDeposit,
    leaseStartDate: input.leaseStartDate,
    leaseEndDate: input.leaseEndDate,
    agreementDate: input.agreementDate,
    includeLetterhead: !input.inNewYork,
    proRateRent: input.proRateRent,
  };

  let pdf;
  try {
    pdf = await generateAgreementPdf({
      ...agreementInput,
      sublessorSignature: { pngDataUrl: sublessorSignature },
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to generate the PDF.";
    await logPreEmailFailure(error);
    return { ok: false, error };
  }

  const id = randomUUID();
  const token = randomUUID();
  const pdfPath = `requests/${id}/sent.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .upload(pdfPath, Buffer.from(pdf.base64, "base64"), {
      contentType: "application/pdf",
    });
  if (uploadError) {
    const error = `Failed to store the PDF: ${uploadError.message}`;
    await logPreEmailFailure(error);
    return { ok: false, error };
  }

  const channel = input.inNewYork ? ("gmail" as const) : ("outlook" as const);
  const { error: insertError } = await supabase.from("agreement_requests").insert({
    id,
    token,
    tenant_name: input.tenantName,
    recipient_email: input.recipientEmail,
    property_address: input.propertyAddress,
    property_id: input.propertyId ?? null,
    include_letterhead: !input.inNewYork,
    channel,
    input: agreementInput,
    unsigned_pdf_path: pdfPath,
    expires_at: new Date(Date.now() + SIGN_LINK_HOURS * 3600_000).toISOString(),
  });
  if (insertError) {
    await supabase.storage.from(AGREEMENTS_BUCKET).remove([pdfPath]);
    const error = `Failed to record the signing request: ${insertError.message}`;
    await logPreEmailFailure(error);
    return { ok: false, error };
  }

  const result = await deliverAgreementEmail({
    channel,
    recipient: input.recipientEmail,
    tenantName: input.tenantName,
    propertyAddress: input.propertyAddress,
    attachment: {
      filename: pdf.filename,
      base64: pdf.base64,
      mimeType: "application/pdf",
    },
    signUrl: signPageUrl(token),
  });

  if (!result.ok) {
    await supabase.from("agreement_requests").delete().eq("id", id);
    await supabase.storage.from(AGREEMENTS_BUCKET).remove([pdfPath]);
    return { ok: false, error: result.error, diag: result.diag };
  }

  return { ok: true, requestId: id, mailbox: channel, diag: result.diag };
}

/**
 * Re-send a pending (possibly expired) request: rotates the token — killing
 * the old link — resets the 48h window, and re-sends the stored PDF.
 */
export async function resendAgreementRequest(
  requestId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = agreementsAdmin();

  const { data: row } = await supabase
    .from("agreement_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle<RequestRow>();
  if (!row) return { ok: false, error: "Signing request not found." };
  if (row.status !== "pending") {
    return {
      ok: false,
      error: `This request is ${row.status} — only pending requests can be re-sent.`,
    };
  }
  if (row.channel === "gmail" && !signOrigin()) {
    return { ok: false, error: NY_SIGN_ORIGIN_ERROR };
  }

  const { data: pdfBlob } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .download(row.unsigned_pdf_path);
  if (!pdfBlob) {
    return { ok: false, error: "The stored agreement PDF is missing." };
  }
  const base64 = Buffer.from(await pdfBlob.arrayBuffer()).toString("base64");

  const newToken = randomUUID();
  const { error: updateError } = await supabase
    .from("agreement_requests")
    .update({
      token: newToken,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + SIGN_LINK_HOURS * 3600_000).toISOString(),
    })
    .eq("id", requestId)
    .eq("status", "pending");
  if (updateError) {
    return { ok: false, error: `Failed to renew the link: ${updateError.message}` };
  }

  const result = await deliverAgreementEmail({
    channel: row.channel,
    recipient: row.recipient_email,
    tenantName: row.tenant_name,
    propertyAddress: row.property_address,
    attachment: {
      filename: agreementPdfFilename(row.tenant_name),
      base64,
      mimeType: "application/pdf",
    },
    signUrl: signPageUrl(newToken),
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}
