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
import { composeFullAddress } from "@/lib/agreement-address";
import { roomLabel } from "@/lib/room-label";

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

const ROOM_REQUIRED_ERROR =
  "Room number is required — every agreement names the specific room being " +
  "subleased. Pick one of the property's rooms.";

function normalizeAddress(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Agreements may only be sent for properties the portal already knows — a
 * free-typed address that matches no property row is refused, on every send
 * path (portal UI, Telegram bot, scripts). Resolves the address to the
 * property's id: an explicit propertyId wins, then an exact match on a
 * previously confirmed agreement address, then street number + street name +
 * unit number against the properties table.
 */
async function resolveKnownProperty(
  supabase: SupabaseClient,
  propertyAddress: string,
  propertyId?: string,
): Promise<{ propertyId: string } | { error: string }> {
  if (propertyId) {
    const { data } = await supabase
      .from("properties")
      .select("id")
      .eq("id", propertyId)
      .maybeSingle();
    if (data) return { propertyId: data.id };
    return {
      error: `No property with id ${propertyId} exists in the portal — agreements can only be sent for properties already in the system.`,
    };
  }

  const wanted = normalizeAddress(propertyAddress);
  const { data: saved } = await supabase
    .from("agreement_addresses")
    .select("property_id, full_address");
  const exact = (saved ?? []).find(
    (s) => normalizeAddress(s.full_address) === wanted,
  );
  if (exact) return { propertyId: exact.property_id };

  const { data: props } = await supabase
    .from("properties")
    .select(
      "id, building_name, street_address, unit_number, neighborhood, is_new_york",
    );
  const tokens = new Set(wanted.split(" "));
  const matches = (props ?? []).filter((p) => {
    const street = normalizeAddress(p.street_address).split(" ");
    const streetNumber = street.find((t) => /^\d/.test(t));
    const streetName = street.find((t) => /^[a-z]/.test(t));
    return (
      streetNumber != null &&
      tokens.has(streetNumber) &&
      streetName != null &&
      tokens.has(streetName) &&
      tokens.has(normalizeAddress(p.unit_number))
    );
  });
  if (matches.length === 1) return { propertyId: matches[0].id };

  const describe = (p: {
    building_name: string | null;
    street_address: string;
    unit_number: string;
    neighborhood: string | null;
    is_new_york: boolean | null;
    id: string;
  }) => {
    const place = p.building_name?.trim() || p.street_address;
    return `${place} Apt ${p.unit_number} — "${composeFullAddress(p).full_address}" (property id ${p.id})`;
  };

  if (matches.length > 1) {
    return {
      error:
        `"${propertyAddress}" matches ${matches.length} properties in the portal — ` +
        `pass the property's id to pick one: ${matches.map(describe).join("; ")}.`,
    };
  }

  // Refused — fuzzy-rank the portal's properties against what was typed so
  // the caller (operator or bot) is told which unit was probably meant.
  const suggestions = (props ?? [])
    .map((p) => {
      const hay = new Set(
        normalizeAddress(
          [p.building_name, p.street_address, p.unit_number]
            .filter(Boolean)
            .join(" "),
        ).split(" "),
      );
      let hits = 0;
      for (const t of tokens) if (hay.has(t)) hits++;
      return { p, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((s) => describe(s.p));
  return {
    error:
      `"${propertyAddress}" doesn't match any property in the portal. ` +
      "Agreements can only be sent for units already in the system — add the " +
      "unit on /properties first, or use one of these existing properties" +
      (suggestions.length > 0
        ? ` (closest matches to what was entered): ${suggestions.join("; ")}.`
        : "."),
  };
}

function normalizeRoom(s: string): string {
  return s.trim().toLowerCase().replace(/^room\s+/, "").replace(/\s+/g, "");
}

/**
 * The room is mandatory and must be one of the property's rooms in the
 * portal — a lease naming a room the unit doesn't have is worse than an
 * error the operator can fix. Matches by room id when given, else by room
 * number (case/whitespace-insensitive, a leading "Room" ignored). Returns the
 * room's id and its number exactly as the portal stores it.
 */
async function resolveKnownRoom(
  supabase: SupabaseClient,
  propertyId: string,
  roomNumber: string,
  roomId?: string,
): Promise<{ roomId: string; roomNumber: string } | { error: string }> {
  const { data: rooms } = await supabase
    .from("rooms")
    .select("id, room_number")
    .eq("property_id", propertyId)
    .order("room_number");
  const list = rooms ?? [];
  const numbered = list.filter(
    (r): r is { id: string; room_number: string } =>
      r.room_number != null && r.room_number.trim() !== "",
  );
  const available =
    numbered.length > 0
      ? `This property's rooms in the portal: ${numbered
          .map((r) => `${roomLabel(r.room_number)} (room id ${r.id})`)
          .join(", ")}.`
      : "This property has no numbered rooms in the portal yet — number its rooms on /properties first.";

  if (roomId) {
    const hit = numbered.find((r) => r.id === roomId);
    if (hit) return { roomId: hit.id, roomNumber: hit.room_number };
    return {
      error: `Room id ${roomId} is not a numbered room of this property. ${available}`,
    };
  }
  const wanted = normalizeRoom(roomNumber);
  const hits = numbered.filter((r) => normalizeRoom(r.room_number) === wanted);
  if (hits.length === 1) {
    return { roomId: hits[0].id, roomNumber: hits[0].room_number };
  }
  if (hits.length > 1) {
    return {
      error: `Room "${roomNumber}" matches ${hits.length} rooms at this property — pass the room's id to pick one. ${available}`,
    };
  }
  return {
    error: `Room "${roomNumber}" doesn't exist at this property in the portal. Agreements name a specific room, so pick one of the property's rooms. ${available}`,
  };
}

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
  /** Room picked from the portal's list (skips room-number matching); must
   *  belong to the resolved property. */
  roomId?: string;
  /** Optional extra paragraph in the cover email (send-time only — not stored,
   *  not in the PDF, and not repeated by a resend). */
  note?: string;
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
  room_number: string | null;
  include_letterhead: boolean;
  channel: "gmail" | "outlook";
  input: AgreementInput;
  unsigned_pdf_path: string;
  expires_at: string;
};

/** "Room 3 · <address>" for logs and alerts; just the address when a legacy
 *  request has no room. */
export function premisesLabel(
  roomNumber: string | null | undefined,
  propertyAddress: string,
): string {
  const room = roomLabel(roomNumber);
  return room ? `${room} · ${propertyAddress}` : propertyAddress;
}

async function deliverAgreementEmail(opts: {
  channel: "gmail" | "outlook";
  recipient: string;
  tenantName: string;
  propertyAddress: string;
  roomNumber: string | null;
  attachment: { filename: string; base64: string; mimeType: string };
  signUrl: string;
  note?: string;
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
      note: opts.note,
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
      note: opts.note,
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
    context: `${opts.tenantName} · ${premisesLabel(opts.roomNumber, opts.propertyAddress)}`,
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
      context: `${input.tenantName} · ${premisesLabel(input.roomNumber, input.propertyAddress)}`,
      channel: input.inNewYork ? "gmail" : "outlook",
      status: "failed",
      error,
    });

  // The room is mandatory on every agreement, from every caller.
  if (!input.roomNumber?.trim()) {
    await logPreEmailFailure(ROOM_REQUIRED_ERROR);
    return { ok: false, error: ROOM_REQUIRED_ERROR };
  }

  // NY correspondence must stay free of Hive branding, including the link's
  // domain — refuse rather than fall back to the hive-portal URL.
  if (input.inNewYork && !signOrigin()) {
    await logPreEmailFailure(NY_SIGN_ORIGIN_ERROR);
    return { ok: false, error: NY_SIGN_ORIGIN_ERROR };
  }

  const known = await resolveKnownProperty(
    supabase,
    input.propertyAddress,
    input.propertyId,
  );
  if ("error" in known) {
    await logPreEmailFailure(known.error);
    return { ok: false, error: known.error };
  }

  const room = await resolveKnownRoom(
    supabase,
    known.propertyId,
    input.roomNumber,
    input.roomId,
  );
  if ("error" in room) {
    await logPreEmailFailure(room.error);
    return { ok: false, error: room.error };
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
    // The portal's own label for the room, not the caller's spelling.
    roomNumber: room.roomNumber,
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
    property_id: known.propertyId,
    room_id: room.roomId,
    room_number: room.roomNumber,
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
    roomNumber: room.roomNumber,
    attachment: {
      filename: pdf.filename,
      base64: pdf.base64,
      mimeType: "application/pdf",
    },
    signUrl: signPageUrl(token),
    note: input.note,
  });

  if (!result.ok) {
    await supabase.from("agreement_requests").delete().eq("id", id);
    await supabase.storage.from(AGREEMENTS_BUCKET).remove([pdfPath]);
    return { ok: false, error: result.error, diag: result.diag };
  }

  // This exact address went out on a real agreement — remember it as the
  // property's canonical agreement address so future sends reuse it verbatim.
  // Best-effort: a save failure must not taint the send report.
  await supabase.from("agreement_addresses").upsert(
    {
      property_id: known.propertyId,
      full_address: input.propertyAddress.trim(),
      confirmed_at: new Date().toISOString(),
    },
    { onConflict: "property_id" },
  );

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
    roomNumber: row.room_number,
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
