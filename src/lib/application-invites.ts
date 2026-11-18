/**
 * Application invites. A team member picks a room on /agreements, sets the
 * rent and deposit, and emails the applicant a hiveny.com apply link. The
 * website checks the link (lookupInvite) and, once the application fee is
 * paid, hands the applicant's details back (completeInvite). That sends the
 * agreement through the normal sendAgreementRequest path, with the room, rent
 * and deposit taken from the invite and only the name and dates from the
 * applicant.
 *
 * New York units don't get invites: their agreements stay on the manual,
 * unbranded flow, and this one is branded throughout.
 */

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { composeFullAddress } from "@/lib/agreement-address";
import { roomLabel } from "@/lib/room-label";
import {
  sendAgreementRequest,
  type AgreementSendInput,
  type AgreementSendResult,
} from "@/lib/agreement-send";
import { sendOutlookMessage } from "@/lib/graph-mail";
import type { SendResult } from "@/lib/google-mail";
import { logEmail } from "@/lib/email-log";
import { applicationInviteEmailTemplate } from "@/lib/email";
import { addTrackingPixel } from "@/lib/email-tracking";

export const INVITE_DAYS = 14;
export const APPLY_NOW_URL = "https://hiveny.com/apply-now";
export const SUBLESSOR_NAME = "Vineet Dutta";
export const NY_INVITE_ERROR =
  "New York units: send the agreement from the Agreements page as usual.";
/** A completion that died mid-send frees its lock after this long. */
const CLAIM_STALE_MS = 5 * 60_000;

export type InviteStatus = "sent" | "used" | "expired" | "cancelled";

export type InviteRow = {
  id: string;
  token: string;
  property_id: string;
  room_id: string;
  applicant_email: string;
  applicant_name: string | null;
  rent: number | string;
  security_deposit: number | string;
  status: InviteStatus;
  expires_at: string;
  used_at: string | null;
  agreement_request_id: string | null;
  website_application_id: string | null;
  tenant_email: string | null;
  claimed_at: string | null;
};

const INVITE_COLUMNS =
  "id, token, property_id, room_id, applicant_email, applicant_name, rent, security_deposit, status, expires_at, used_at, agreement_request_id, website_application_id, tenant_email, claimed_at";

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function inviteUrl(token: string): string {
  return `${APPLY_NOW_URL}?invite=${encodeURIComponent(token)}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** A stored "sent" invite past its expiry reads as expired. */
export function effectiveStatus(
  row: { status: InviteStatus; expires_at: string },
  now: Date = new Date(),
): InviteStatus {
  if (row.status === "sent" && new Date(row.expires_at) <= now) return "expired";
  return row.status;
}

/** "2050" / "2050.50" for agreement inputs. */
export function moneyString(value: number | string): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** "$1,850" / "$937.50" for emails and the UI. */
export function formatUsd(value: number | string): string {
  const n = Number(value);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function sameEmail(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

type PropertyRow = {
  id: string;
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  is_new_york: boolean | null;
};

async function loadPremises(
  supabase: SupabaseClient,
  propertyId: string,
  roomId: string,
): Promise<
  | {
      ok: true;
      property: PropertyRow;
      roomNumber: string;
      totalRent: number | null;
      address: string;
      addressComplete: boolean;
    }
  | { ok: false; error: string }
> {
  const [{ data: property }, { data: room }, { data: saved }] = await Promise.all([
    supabase
      .from("properties")
      .select("id, street_address, unit_number, neighborhood, is_new_york")
      .eq("id", propertyId)
      .maybeSingle<PropertyRow>(),
    supabase
      .from("rooms")
      .select("id, property_id, room_number, total_rent")
      .eq("id", roomId)
      .maybeSingle<{
        id: string;
        property_id: string;
        room_number: string | null;
        total_rent: number | null;
      }>(),
    supabase
      .from("agreement_addresses")
      .select("full_address")
      .eq("property_id", propertyId)
      .maybeSingle<{ full_address: string }>(),
  ]);
  if (!property) return { ok: false, error: "That unit no longer exists." };
  if (!room || room.property_id !== property.id) {
    return { ok: false, error: "That room isn't part of the chosen unit." };
  }
  if (!room.room_number?.trim()) {
    return {
      ok: false,
      error: "That room has no number yet. Number it on /properties first.",
    };
  }
  // Same address the Agreements form offers: the one confirmed on an earlier
  // agreement, else the composed one.
  const composed = composeFullAddress(property);
  return {
    ok: true,
    property,
    roomNumber: room.room_number.trim(),
    totalRent: room.total_rent,
    address: saved?.full_address ?? composed.full_address,
    addressComplete: Boolean(saved) || !composed.needs_city_state,
  };
}

// ---------------------------------------------------------------------------
// Create / cancel (portal UI, as the signed-in user so RLS and the audit log
// see who did it)
// ---------------------------------------------------------------------------

export type CreateInviteInput = {
  propertyId: string;
  roomId: string;
  applicantEmail: string;
  applicantName?: string;
  rent: string;
  securityDeposit: string;
};

export type CreateInviteResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanMoney(v: string): string | null {
  const cleaned = String(v ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) return null;
  return cleaned;
}

type InviteMailer = (opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => Promise<SendResult>;

const defaultMailer: InviteMailer = (opts) => sendOutlookMessage(opts);

/**
 * Validate, store and email a new invite. Fails without side effects: if the
 * email doesn't go out, the invite row is removed again.
 */
export async function createInvite(
  supabase: SupabaseClient,
  input: CreateInviteInput,
  deps: { mail?: InviteMailer; now?: () => Date } = {},
): Promise<CreateInviteResult> {
  const mail = deps.mail ?? defaultMailer;
  const now = deps.now?.() ?? new Date();

  const email = String(input.applicantEmail ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: `"${email}" doesn't look like a valid email address.` };
  }
  const name = String(input.applicantName ?? "").trim() || null;
  if (name && name.length > 200) return { ok: false, error: "That name is too long." };
  if (!UUID_RE.test(input.propertyId ?? "")) return { ok: false, error: "Pick a unit." };
  if (!UUID_RE.test(input.roomId ?? "")) return { ok: false, error: "Pick a room." };
  const rent = cleanMoney(input.rent);
  if (!rent) return { ok: false, error: `Rent "${input.rent}" is not a valid amount.` };
  const deposit = cleanMoney(input.securityDeposit);
  if (!deposit) {
    return {
      ok: false,
      error: `Security deposit "${input.securityDeposit}" is not a valid amount.`,
    };
  }

  const premises = await loadPremises(supabase, input.propertyId, input.roomId);
  if (!premises.ok) return premises;
  if (premises.property.is_new_york) return { ok: false, error: NY_INVITE_ERROR };
  if (!premises.addressComplete) {
    return {
      ok: false,
      error:
        "This unit's address has no city and state on file, so its agreement would be incomplete. " +
        "Send one agreement for it from the form below first; that saves the full address.",
    };
  }

  const token = newInviteToken();
  const { data: created, error: insertError } = await supabase
    .from("application_invites")
    .insert({
      token,
      property_id: input.propertyId,
      room_id: input.roomId,
      applicant_email: email,
      applicant_name: name,
      rent: Number(rent),
      security_deposit: Number(deposit),
      status: "sent",
      expires_at: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !created) {
    return {
      ok: false,
      error: `Couldn't save the invite: ${insertError?.message ?? "no row returned"}`,
    };
  }

  const url = inviteUrl(token);
  const room = roomLabel(premises.roomNumber);
  const body = applicationInviteEmailTemplate({
    applicantName: name,
    roomLabel: room,
    neighborhood: premises.property.neighborhood,
    rent: formatUsd(rent),
    url,
  });
  const tracked = addTrackingPixel(body.html);
  const result = await mail({
    to: email,
    subject: body.subject,
    text: body.text,
    html: tracked.html,
  });
  await logEmail({
    type: "application_invite",
    recipient: email,
    subject: body.subject,
    context: `${name ?? email} · ${room} · ${premises.address}`,
    channel: "outlook",
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
    resend_id: result.ok ? result.id || null : null,
    track_id: result.ok ? tracked.trackId : null,
    attempts: result.attempts,
  });

  if (!result.ok) {
    await supabase.from("application_invites").delete().eq("id", created.id);
    return { ok: false, error: `The invite email didn't go out: ${result.error}` };
  }

  await supabase
    .from("application_invites")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("id", created.id);
  return { ok: true, id: created.id, url };
}

export async function cancelInvite(
  supabase: SupabaseClient,
  inviteId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!UUID_RE.test(inviteId ?? "")) return { ok: false, error: "Invalid invite id." };
  const { data, error } = await supabase
    .from("application_invites")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("status", "sent")
    .is("claimed_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only open invites can be cancelled (this one was used, cancelled, or is completing right now).",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Keyed website API (service role)
// ---------------------------------------------------------------------------

export type ApiResult = { httpStatus: number; body: Record<string, unknown> };

function statusResponse(status: InviteStatus | "not_found"): ApiResult {
  if (status === "not_found") return { httpStatus: 404, body: { status } };
  return { httpStatus: 410, body: { status } };
}

/**
 * GET /api/applications/invites/{token}. Public-facing data only: the room
 * label, the neighborhood and the rent. Never the street address or unit
 * number.
 */
export async function lookupInvite(
  supabase: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<ApiResult> {
  if (!TOKEN_RE.test(token ?? "")) return statusResponse("not_found");
  const { data: invite } = await supabase
    .from("application_invites")
    .select("id, property_id, room_id, rent, status, expires_at")
    .eq("token", token)
    .maybeSingle<
      Pick<InviteRow, "id" | "property_id" | "room_id" | "rent" | "status" | "expires_at">
    >();
  if (!invite) return statusResponse("not_found");
  const status = effectiveStatus(invite, now);
  if (status !== "sent") return statusResponse(status);

  const [{ data: room }, { data: property }] = await Promise.all([
    supabase
      .from("rooms")
      .select("room_number")
      .eq("id", invite.room_id)
      .maybeSingle<{ room_number: string | null }>(),
    supabase
      .from("properties")
      .select("neighborhood")
      .eq("id", invite.property_id)
      .maybeSingle<{ neighborhood: string | null }>(),
  ]);
  if (!room) return statusResponse("not_found");
  return {
    httpStatus: 200,
    body: {
      status: "valid",
      invite: {
        room_label: roomLabel(room.room_number) || "Room",
        neighborhood: property?.neighborhood?.trim() || null,
        monthly_rent: Number(invite.rent),
        expires_at: invite.expires_at,
      },
    },
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const completeSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).regex(EMAIL_RE),
  phone: z.string().trim().max(40).optional().default(""),
  start_date: z.string().refine(isRealIsoDate),
  end_date: z.string().refine(isRealIsoDate),
  website_application_id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().min(1).max(100)),
});

export type CompleteDeps = {
  send?: (input: AgreementSendInput) => Promise<AgreementSendResult>;
  now?: () => Date;
  today?: () => string;
};

function alreadySent(invite: InviteRow, websiteApplicationId: string): ApiResult {
  if (invite.website_application_id === websiteApplicationId) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: "already_sent",
        agreement_request_id: invite.agreement_request_id,
        email_differs: !sameEmail(invite.tenant_email, invite.applicant_email),
      },
    };
  }
  return {
    httpStatus: 410,
    body: { ok: false, status: "used", error: "This invite was already used by another application." },
  };
}

/**
 * POST /api/applications/complete. Idempotent: the invite is claimed
 * atomically before anything is sent, a repeat call for the same application
 * returns the agreement already sent, and a completion that died mid-send is
 * reconciled against agreement_requests instead of sending again.
 */
export async function completeInvite(
  supabase: SupabaseClient,
  raw: unknown,
  deps: CompleteDeps = {},
): Promise<ApiResult> {
  const send = deps.send ?? sendAgreementRequest;
  const now = deps.now?.() ?? new Date();
  const today = deps.today?.() ?? todayISO();

  const parsed = completeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      httpStatus: 400,
      body: {
        ok: false,
        status: "invalid_request",
        error: `Invalid fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ")}`,
      },
    };
  }
  const input = parsed.data;

  const { data: invite } = await supabase
    .from("application_invites")
    .select(INVITE_COLUMNS)
    .eq("token", input.token)
    .maybeSingle<InviteRow>();
  if (!invite) {
    return { httpStatus: 404, body: { ok: false, status: "not_found" } };
  }

  // A repeat call for the application that used the invite is a success.
  if (invite.status === "used") return alreadySent(invite, input.website_application_id);
  const status = effectiveStatus(invite, now);
  if (status === "cancelled" || status === "expired") {
    return { httpStatus: 410, body: { ok: false, status, error: `This invite is ${status}.` } };
  }

  if (input.start_date < today) {
    return {
      httpStatus: 400,
      body: { ok: false, status: "invalid_dates", error: "The start date must be today or later." },
    };
  }
  if (input.end_date <= input.start_date) {
    return {
      httpStatus: 400,
      body: { ok: false, status: "invalid_dates", error: "The end date must be after the start date." },
    };
  }

  // Claim the invite. Only one caller gets the row back; a stale claim (a
  // completion that died) can be taken over.
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const { data: claimed } = await supabase
    .from("application_invites")
    .update({
      claimed_at: nowIso,
      website_application_id: input.website_application_id,
      tenant_name: input.full_name,
      tenant_email: input.email,
      tenant_phone: input.phone || null,
      lease_start_date: input.start_date,
      lease_end_date: input.end_date,
    })
    .eq("id", invite.id)
    .eq("status", "sent")
    .gt("expires_at", nowIso)
    .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
    .select("id")
    .maybeSingle<{ id: string }>();
  if (!claimed) {
    const { data: fresh } = await supabase
      .from("application_invites")
      .select(INVITE_COLUMNS)
      .eq("id", invite.id)
      .maybeSingle<InviteRow>();
    if (fresh?.status === "used") return alreadySent(fresh, input.website_application_id);
    return {
      httpStatus: 409,
      body: { ok: false, status: "in_progress", error: "This invite is being completed right now." },
    };
  }

  const markUsed = async (agreementRequestId: string) => {
    await supabase
      .from("application_invites")
      .update({
        status: "used",
        used_at: new Date().toISOString(),
        agreement_request_id: agreementRequestId,
        claimed_at: null,
      })
      .eq("id", invite.id);
  };
  const release = async () => {
    await supabase
      .from("application_invites")
      .update({ claimed_at: null })
      .eq("id", invite.id);
  };
  const sentBody = (agreementRequestId: string, status: "sent" | "already_sent"): ApiResult => ({
    httpStatus: 200,
    body: {
      ok: true,
      status,
      agreement_request_id: agreementRequestId,
      email_differs: !sameEmail(input.email, invite.applicant_email),
    },
  });

  // An earlier claim that never finished may still have sent the agreement
  // (it died between the email and marking the invite used). Adopt that
  // agreement instead of sending a second one.
  if (invite.claimed_at) {
    const { data: earlier } = await supabase
      .from("agreement_requests")
      .select("id, recipient_email")
      .eq("room_id", invite.room_id)
      .gte("created_at", invite.claimed_at)
      .order("created_at", { ascending: false })
      .returns<{ id: string; recipient_email: string }[]>();
    const match = (earlier ?? []).find((r) => sameEmail(r.recipient_email, invite.applicant_email));
    if (match) {
      await markUsed(match.id);
      return sentBody(match.id, "already_sent");
    }
  }

  const premises = await loadPremises(supabase, invite.property_id, invite.room_id);
  if (!premises.ok) {
    await release();
    return { httpStatus: 400, body: { ok: false, status: "invalid_request", error: premises.error } };
  }
  if (premises.property.is_new_york) {
    await release();
    return { httpStatus: 400, body: { ok: false, status: "invalid_request", error: NY_INVITE_ERROR } };
  }

  // Terms come from the invite; the applicant supplies only the name and dates.
  // The agreement goes to the invite email: that's the person Hive vetted.
  const result = await send({
    tenantName: input.full_name,
    sublessorName: SUBLESSOR_NAME,
    propertyAddress: premises.address,
    roomNumber: premises.roomNumber,
    rent: moneyString(invite.rent),
    securityDeposit: moneyString(invite.security_deposit),
    leaseStartDate: input.start_date,
    leaseEndDate: input.end_date,
    agreementDate: today,
    recipientEmail: invite.applicant_email,
    inNewYork: false,
    propertyId: invite.property_id,
    roomId: invite.room_id,
  });
  if (!result.ok) {
    await release();
    console.error(`[application-invites] ${invite.id}: agreement send failed: ${result.error}`);
    return {
      httpStatus: 502,
      body: {
        ok: false,
        status: "send_failed",
        error: "The portal couldn't send the agreement. It will be retried; details are in the portal's email log.",
      },
    };
  }

  await markUsed(result.requestId);
  return sentBody(result.requestId, "sent");
}
