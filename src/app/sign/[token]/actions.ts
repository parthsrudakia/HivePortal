"use server";

import { headers } from "next/headers";
import { todayISO } from "@/lib/date";
import {
  generateAgreementPdf,
  agreementPdfFilename,
  type AgreementInput,
} from "@/lib/agreements";
import {
  AGREEMENTS_BUCKET,
  agreementsAdmin,
  loadOperatorSignature,
  premisesLabel,
} from "@/lib/agreement-send";
import { sendGmailMessage } from "@/lib/google-mail";
import { sendOutlookMessage } from "@/lib/graph-mail";
import {
  gmailSignedAgreementBody,
  signedAgreementEmailTemplate,
} from "@/lib/email";
import { logEmail } from "@/lib/email-log";
import { notifyOperators } from "@/lib/telegram";

// Matches the client-side cap in sign-form.tsx; server actions reject bodies
// over ~1MB anyway, this just gives a friendlier error first.
const MAX_DATA_URL_CHARS = 400_000;

type RequestRow = {
  id: string;
  tenant_name: string;
  recipient_email: string;
  property_address: string;
  room_number: string | null;
  channel: "gmail" | "outlook";
  /** Snapshot the sent PDF was rendered from. Requests sent before the room
   *  became mandatory have no roomNumber in here; the builder tolerates it. */
  input: AgreementInput;
};

export async function submitSignature(
  token: string,
  payload: { pngDataUrl: string; kind: "drawn" | "typed" },
): Promise<{ ok: boolean; error?: string }> {
  if (
    typeof payload?.pngDataUrl !== "string" ||
    !payload.pngDataUrl.startsWith("data:image/png;base64,") ||
    payload.pngDataUrl.length > MAX_DATA_URL_CHARS
  ) {
    return { ok: false, error: "That signature couldn't be read — please try again." };
  }
  if (payload.kind !== "drawn" && payload.kind !== "typed") {
    return { ok: false, error: "That signature couldn't be read — please try again." };
  }

  const supabase = agreementsAdmin();

  // Fresh token lookup — never trust the page render that got the tenant here.
  const { data: request } = await supabase
    .from("agreement_requests")
    .select("id, tenant_name, recipient_email, property_address, room_number, channel, input")
    .eq("token", token)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<RequestRow>();
  if (!request) {
    return {
      ok: false,
      error:
        "This signing link is no longer valid — it may have expired or already been used. Reply to the email you received for a fresh link.",
    };
  }

  const sublessorSignature = await loadOperatorSignature(supabase);
  if (!sublessorSignature) {
    return { ok: false, error: "Something went wrong on our side — please reply to the email you received." };
  }

  const signDate = todayISO();
  const hdrs = await headers();
  const signIp =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Claim the request first (compare-and-set on status) so a double submit
  // can't produce two signed PDFs or two emails.
  const { data: claimed } = await supabase
    .from("agreement_requests")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      tenant_signature_kind: payload.kind,
      sign_ip: signIp,
    })
    .eq("id", request.id)
    .eq("status", "pending")
    .select("id");
  if (!claimed || claimed.length === 0) {
    return {
      ok: false,
      error: "This agreement was already signed — a copy is on its way to your email.",
    };
  }

  const revert = async () => {
    await supabase
      .from("agreement_requests")
      .update({
        status: "pending",
        signed_at: null,
        tenant_signature_kind: null,
        sign_ip: null,
      })
      .eq("id", request.id);
  };

  // Re-render the agreement from the stored input with both signatures. Same
  // builder and same input as the sent PDF, so the document is identical bar
  // the added signature and date.
  let pdf;
  try {
    pdf = await generateAgreementPdf({
      ...request.input,
      sublessorSignature: { pngDataUrl: sublessorSignature },
      tenantSignature: { pngDataUrl: payload.pngDataUrl },
      tenantSignDate: signDate,
    });
  } catch {
    await revert();
    return { ok: false, error: "Something went wrong preparing the signed PDF — please try again." };
  }

  const signedPath = `requests/${request.id}/signed.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .upload(signedPath, Buffer.from(pdf.base64, "base64"), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) {
    await revert();
    return { ok: false, error: "Something went wrong saving the signed PDF — please try again." };
  }

  await supabase
    .from("agreement_requests")
    .update({ signed_pdf_path: signedPath })
    .eq("id", request.id);

  // Email the signed copy back on the same channel as the original send. A
  // failure here does NOT undo the signing — the PDF is stored and the
  // operator can re-send it from the portal.
  const attachment = {
    filename: agreementPdfFilename(request.tenant_name).replace(
      /\.pdf$/i,
      " (signed).pdf",
    ),
    base64: pdf.base64,
    mimeType: "application/pdf",
  };
  let result;
  let subject: string;
  if (request.channel === "gmail") {
    const body = gmailSignedAgreementBody({ tenantName: request.tenant_name });
    subject = body.subject;
    result = await sendGmailMessage({
      to: request.recipient_email,
      subject: body.subject,
      text: body.text,
      attachment,
      verifySent: true,
    });
  } else {
    const body = signedAgreementEmailTemplate({ tenantName: request.tenant_name });
    subject = body.subject;
    result = await sendOutlookMessage({
      to: request.recipient_email,
      subject: body.subject,
      text: body.text,
      html: body.html,
      attachment,
    });
  }

  await logEmail({
    type: "agreement_signed",
    recipient: request.recipient_email,
    subject,
    context: `${request.tenant_name} · ${premisesLabel(request.room_number, request.property_address)}`,
    channel: request.channel,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
  });

  // Alert the operators on Telegram. On a confirmed send, stamp the row as
  // notified; otherwise leave it unstamped and the daily cron sweep
  // (retrySignedAgreementAlerts) re-sends until it lands.
  const notified = await notifyOperators(
    [
      `✍️ ${request.tenant_name} just signed their agreement`,
      premisesLabel(request.room_number, request.property_address),
      result.ok
        ? `Signed copy emailed to ${request.recipient_email}.`
        : `⚠️ Emailing the signed copy failed — re-send it from the portal.`,
    ].join("\n"),
  );
  if (notified) {
    await supabase
      .from("agreement_requests")
      .update({ operator_notified_at: new Date().toISOString() })
      .eq("id", request.id);
  }

  return { ok: true };
}
