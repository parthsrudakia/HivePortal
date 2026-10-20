"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import {
  AGREEMENTS_BUCKET,
  OPERATOR_SIGNATURE_PATH,
  sendAgreementRequest,
  resendAgreementRequest,
} from "@/lib/agreement-send";
import { assertSection } from "@/lib/section-access";

// Matches the pad's client-side cap; a real signature PNG is a few KB.
const MAX_DATA_URL_CHARS = 400_000;

const SINGLE_EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

type ActionResult = { ok: boolean; error?: string };

async function requireUser() {
  const supabase = await createClient();
  const user = await getSessionUser();
  return { supabase, user };
}

/** Save (or replace) the operator's signature used on every outgoing agreement. */
export async function saveOperatorSignature(
  pngDataUrl: string,
): Promise<ActionResult> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (
    typeof pngDataUrl !== "string" ||
    !pngDataUrl.startsWith("data:image/png;base64,") ||
    pngDataUrl.length > MAX_DATA_URL_CHARS
  ) {
    return { ok: false, error: "That signature couldn't be read — try again." };
  }
  const bytes = Buffer.from(
    pngDataUrl.slice("data:image/png;base64,".length),
    "base64",
  );
  const { error } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .upload(OPERATOR_SIGNATURE_PATH, bytes, {
      contentType: "image/png",
      upsert: true,
    });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/agreements");
  return { ok: true };
}

export type SendToTenantPayload = {
  tenantName: string;
  sublessorName: string;
  propertyAddress: string;
  /** Mandatory — the room within the unit; must be one of the property's
   *  rooms in the portal. */
  roomNumber: string;
  /** Room picked from the property's room list; skips room-number matching. */
  roomId?: string;
  rent: string;
  securityDeposit: string;
  leaseStartDate: string;
  leaseEndDate: string;
  agreementDate: string;
  proRateRent?: string;
  recipientEmail: string;
  inNewYork: boolean;
  /** Property picked from the portal's list — the address must always resolve
   *  to an existing property; passing the id skips address re-matching. */
  propertyId?: string;
  /** Optional extra paragraph in the cover email — send-time only, not
   *  stored, not in the PDF, not repeated by a resend. */
  note?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanMoney(v: string): string | null {
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) return null;
  return cleaned;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Server-side regeneration + send with signing link — the canonical artifact
 *  never comes from the browser. */
export async function sendAgreementToTenant(
  payload: SendToTenantPayload,
): Promise<ActionResult> {
  await assertSection("agreements");
  const { user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const recipient = payload.recipientEmail.trim();
  if (!SINGLE_EMAIL_RE.test(recipient)) {
    return { ok: false, error: `"${recipient}" doesn't look like a valid email address.` };
  }
  if (!payload.tenantName.trim()) return { ok: false, error: "Tenant name is required." };
  if (!payload.sublessorName.trim()) return { ok: false, error: "Sublessor name is required." };
  if (!payload.propertyAddress.trim()) return { ok: false, error: "Property address is required." };
  if (!payload.roomNumber?.trim()) return { ok: false, error: "Room number is required." };
  const rent = cleanMoney(payload.rent);
  if (!rent) return { ok: false, error: `Rent "${payload.rent}" is not a valid amount.` };
  const deposit = cleanMoney(payload.securityDeposit);
  if (!deposit) {
    return { ok: false, error: `Security deposit "${payload.securityDeposit}" is not a valid amount.` };
  }
  const proRate = payload.proRateRent?.trim() ? cleanMoney(payload.proRateRent) : undefined;
  if (payload.proRateRent?.trim() && !proRate) {
    return { ok: false, error: `Prorated rent "${payload.proRateRent}" is not a valid amount.` };
  }
  if (
    !ISO_DATE_RE.test(payload.leaseStartDate) ||
    !ISO_DATE_RE.test(payload.leaseEndDate) ||
    !ISO_DATE_RE.test(payload.agreementDate)
  ) {
    return { ok: false, error: "Dates must be provided as YYYY-MM-DD." };
  }
  if (payload.leaseEndDate <= payload.leaseStartDate) {
    return { ok: false, error: "Lease end date must be after the start date." };
  }
  if (payload.propertyId && !UUID_RE.test(payload.propertyId)) {
    return { ok: false, error: "Invalid property id." };
  }
  if (payload.roomId && !UUID_RE.test(payload.roomId)) {
    return { ok: false, error: "Invalid room id." };
  }
  const note = payload.note?.trim() || undefined;
  if (note && note.length > 1000) {
    return { ok: false, error: "The cover-email note must be 1,000 characters or fewer." };
  }

  const result = await sendAgreementRequest({
    tenantName: payload.tenantName.trim(),
    sublessorName: payload.sublessorName.trim(),
    propertyAddress: payload.propertyAddress.trim(),
    roomNumber: payload.roomNumber.trim(),
    rent,
    securityDeposit: deposit,
    leaseStartDate: payload.leaseStartDate,
    leaseEndDate: payload.leaseEndDate,
    agreementDate: payload.agreementDate,
    proRateRent: proRate ?? undefined,
    recipientEmail: recipient,
    inNewYork: payload.inNewYork,
    propertyId: payload.propertyId || undefined,
    roomId: payload.roomId || undefined,
    note,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/agreements");
  return { ok: true };
}

/** Remove an entry from the tally (deal fell through, signed on paper, …). */
export async function dismissRequest(requestId: string): Promise<ActionResult> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { error } = await supabase
    .from("agreement_requests")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .eq("id", requestId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/agreements");
  return { ok: true };
}

/** Bring a dismissed entry back — to signed if it was signed, else pending. */
export async function undismissRequest(requestId: string): Promise<ActionResult> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: row } = await supabase
    .from("agreement_requests")
    .select("signed_at")
    .eq("id", requestId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Request not found." };
  const { error } = await supabase
    .from("agreement_requests")
    .update({
      status: row.signed_at ? "signed" : "pending",
      dismissed_at: null,
    })
    .eq("id", requestId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/agreements");
  return { ok: true };
}

/**
 * Permanently clear a tally list: deletes the matching requests AND their
 * stored PDFs from the agreements bucket. Dismissed clears everything
 * dismissed; signed clears only entries already assigned to a tenant (their
 * copy lives on in the leases bucket), so an unassigned signature can never
 * be dropped from the portal.
 */
export async function clearRequests(
  status: "signed" | "dismissed",
): Promise<ActionResult & { cleared?: number }> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Signed entries are only cleared once their PDF has been saved to a
  // tenant's profile — an unassigned signed copy is the sole copy of that
  // signature in the portal, so it stays in the tally until it's assigned.
  let query = supabase
    .from("agreement_requests")
    .select("id, unsigned_pdf_path, signed_pdf_path")
    .eq("status", status);
  if (status === "signed") query = query.not("assigned_tenancy_id", "is", null);
  const { data: rows, error } = await query;
  if (error) return { ok: false, error: error.message };
  if (!rows || rows.length === 0) return { ok: true, cleared: 0 };

  // Files first (best-effort), then rows — a failed file delete must not
  // leave the tally entry pointing at nothing.
  const paths = rows.flatMap((r) =>
    [r.unsigned_pdf_path, r.signed_pdf_path].filter(
      (p): p is string => p != null,
    ),
  );
  if (paths.length > 0) {
    await supabase.storage.from(AGREEMENTS_BUCKET).remove(paths);
  }
  const { error: deleteError } = await supabase
    .from("agreement_requests")
    .delete()
    .in(
      "id",
      rows.map((r) => r.id),
    );
  if (deleteError) return { ok: false, error: deleteError.message };

  revalidatePath("/agreements");
  return { ok: true, cleared: rows.length };
}

/** Rotate the token (+48h) and re-send the email with the stored PDF. */
export async function resendRequest(requestId: string): Promise<ActionResult> {
  await assertSection("agreements");
  const { user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const result = await resendAgreementRequest(requestId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/agreements");
  return { ok: true };
}

/** Short-lived link to view a request's PDF (signed copy when available). */
export async function getRequestPdfUrl(
  requestId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: row } = await supabase
    .from("agreement_requests")
    .select("unsigned_pdf_path, signed_pdf_path")
    .eq("id", requestId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Request not found." };
  const path = row.signed_pdf_path ?? row.unsigned_pdf_path;
  const { data, error } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .createSignedUrl(path, 60);
  if (error || !data) return { ok: false, error: error?.message ?? "No PDF found." };
  return { ok: true, url: data.signedUrl };
}

/**
 * Attach a signed agreement to a tenancy: copies the signed PDF into the
 * `leases` bucket (so the request's own copy stays immutable) and points
 * tenancies.lease_pdf_path at it — the tenant profile's existing Lease PDF
 * button picks it up from there.
 */
export async function assignToTenancy(
  requestId: string,
  tenancyId: string,
  opts: { replace?: boolean } = {},
): Promise<ActionResult & { needsReplace?: boolean }> {
  await assertSection("agreements");
  const { supabase, user } = await requireUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: request } = await supabase
    .from("agreement_requests")
    .select("id, status, signed_pdf_path, tenant_name")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) return { ok: false, error: "Request not found." };
  if (request.status !== "signed" || !request.signed_pdf_path) {
    return { ok: false, error: "Only signed agreements can be assigned to a tenant." };
  }

  const { data: tenancy } = await supabase
    .from("tenancies")
    .select("id, tenant_id, lease_pdf_path")
    .eq("id", tenancyId)
    .maybeSingle();
  if (!tenancy) return { ok: false, error: "Tenancy not found." };
  if (tenancy.lease_pdf_path && !opts.replace) {
    return {
      ok: false,
      needsReplace: true,
      error: "This tenant already has a lease PDF on file.",
    };
  }

  const { data: pdfBlob, error: downloadError } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .download(request.signed_pdf_path);
  if (downloadError || !pdfBlob) {
    return { ok: false, error: "The signed PDF could not be read from storage." };
  }

  const leasePath = `${tenancy.tenant_id}/${Date.now()}-signed-agreement.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("leases")
    .upload(leasePath, Buffer.from(await pdfBlob.arrayBuffer()), {
      contentType: "application/pdf",
    });
  if (uploadError) return { ok: false, error: uploadError.message };

  const { error: tenancyError } = await supabase
    .from("tenancies")
    .update({ lease_pdf_path: leasePath })
    .eq("id", tenancyId);
  if (tenancyError) {
    await supabase.storage.from("leases").remove([leasePath]);
    return { ok: false, error: tenancyError.message };
  }

  await supabase
    .from("agreement_requests")
    .update({
      assigned_tenancy_id: tenancyId,
      assigned_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  revalidatePath("/agreements");
  revalidatePath(`/tenants/${tenancy.tenant_id}`);
  return { ok: true };
}
