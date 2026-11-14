/**
 * Auto-attach a freshly signed agreement to the tenant's profile.
 *
 * When a tenant signs and a profile already exists for them, the signed PDF
 * is copied into the `leases` bucket and the matching tenancy's
 * `lease_pdf_path` is pointed at it — the same end state as the tally's
 * manual "Assign to tenant", without anyone having to click it.
 *
 * Matching is deliberately strict; anything ambiguous is left in the tally
 * for a manual assign:
 *   - the tenant is found by the agreement's recipient email, or failing
 *     that by an exact (case-insensitive) full-name match;
 *   - the tenancy must be active or upcoming and in the room the agreement
 *     was sent for (same property when the request predates mandatory
 *     rooms). An existing tenant signing for a *different* room — a transfer
 *     whose tenancy isn't created yet — therefore attaches nothing;
 *   - exactly one tenancy must match.
 *
 * A request already linked to a tenancy (the profile was created from the
 * outstanding tally, which attaches the unsigned agreement) skips the
 * matching: the signed copy goes to that tenancy and replaces the unsigned
 * one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGREEMENTS_BUCKET } from "@/lib/agreement-send";
import { isUnsignedLeasePath } from "@/lib/lease-path";
import { one } from "@/lib/relations";

export type AttachCandidate = {
  id: string;
  tenant_id: string;
  room_id: string | null;
  property_id: string | null;
  /** True when the tenant was matched by email rather than by name only. */
  matchedByEmail: boolean;
};

/**
 * Pick the one tenancy a signed agreement belongs to, or null when there is
 * no match or more than one.
 */
export function pickTenancyForAgreement(
  request: { room_id: string | null; property_id: string | null },
  candidates: AttachCandidate[],
): AttachCandidate | null {
  let matches: AttachCandidate[];
  if (request.room_id) {
    matches = candidates.filter((c) => c.room_id === request.room_id);
  } else if (request.property_id) {
    // Older requests carry no room: same unit is enough, but only for a
    // tenant matched by email — a name alone is too weak without the room.
    matches = candidates.filter(
      (c) => c.matchedByEmail && c.property_id === request.property_id,
    );
  } else {
    matches = candidates.filter((c) => c.matchedByEmail);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Escape the LIKE wildcards so an ilike compares the whole string literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type AutoAttachResult =
  | { attached: true; tenancyId: string; tenantId: string }
  | { attached: false; reason: string };

/**
 * Attach the request's signed PDF to its tenant's tenancy, if one can be
 * identified. Never throws — signing must not fail because of this.
 */
export async function autoAttachSignedAgreement(
  supabase: SupabaseClient,
  requestId: string,
): Promise<AutoAttachResult> {
  try {
    const { data: request } = await supabase
      .from("agreement_requests")
      .select(
        "id, status, signed_pdf_path, tenant_name, recipient_email, room_id, property_id, assigned_tenancy_id",
      )
      .eq("id", requestId)
      .maybeSingle();
    if (!request) return { attached: false, reason: "request not found" };
    if (request.status !== "signed" || !request.signed_pdf_path) {
      return { attached: false, reason: "not signed" };
    }
    if (request.assigned_tenancy_id) {
      const { data: linked } = await supabase
        .from("tenancies")
        .select("id, tenant_id, lease_pdf_path")
        .eq("id", request.assigned_tenancy_id)
        .maybeSingle();
      if (!linked) return { attached: false, reason: "linked tenancy not found" };
      return await attachTo(supabase, request, linked);
    }

    const email = (request.recipient_email ?? "").trim();
    const name = (request.tenant_name ?? "").trim();
    const [byEmail, byName] = await Promise.all([
      email
        ? supabase.from("tenants").select("id").ilike("email", likeLiteral(email))
        : Promise.resolve({ data: [] as { id: string }[], error: null }),
      name
        ? supabase.from("tenants").select("id").ilike("full_name", likeLiteral(name))
        : Promise.resolve({ data: [] as { id: string }[], error: null }),
    ]);
    if (byEmail.error || byName.error) {
      return { attached: false, reason: "tenant lookup failed" };
    }
    const emailIds = new Set((byEmail.data ?? []).map((t) => t.id));
    // Name is only a fallback for when the email finds no profile at all.
    const tenantIds =
      emailIds.size > 0 ? [...emailIds] : (byName.data ?? []).map((t) => t.id);
    if (tenantIds.length === 0) {
      return { attached: false, reason: "no tenant profile" };
    }

    const { data: tenancies, error: tenancyError } = await supabase
      .from("tenancies")
      .select("id, tenant_id, room_id, lease_pdf_path, rooms(property_id)")
      .in("tenant_id", tenantIds)
      .in("status", ["active", "upcoming"]);
    if (tenancyError) return { attached: false, reason: "tenancy lookup failed" };

    const rows = (tenancies ?? []) as {
      id: string;
      tenant_id: string;
      room_id: string | null;
      lease_pdf_path: string | null;
      rooms: { property_id: string | null } | { property_id: string | null }[] | null;
    }[];
    const picked = pickTenancyForAgreement(
      request,
      rows.map((t) => ({
        id: t.id,
        tenant_id: t.tenant_id,
        room_id: t.room_id,
        property_id: one(t.rooms)?.property_id ?? null,
        matchedByEmail: emailIds.has(t.tenant_id),
      })),
    );
    if (!picked) return { attached: false, reason: "no single matching tenancy" };

    const target = rows.find((t) => t.id === picked.id)!;
    return await attachTo(supabase, request, target);
  } catch (e) {
    return {
      attached: false,
      reason: e instanceof Error ? e.message : "unexpected error",
    };
  }
}

async function attachTo(
  supabase: SupabaseClient,
  request: { id: string; signed_pdf_path: string },
  tenancy: { id: string; tenant_id: string; lease_pdf_path: string | null },
): Promise<AutoAttachResult> {
  const { data: pdfBlob, error: downloadError } = await supabase.storage
    .from(AGREEMENTS_BUCKET)
    .download(request.signed_pdf_path);
  if (downloadError || !pdfBlob) {
    return { attached: false, reason: "signed PDF unreadable" };
  }

  const leasePath = `${tenancy.tenant_id}/${Date.now()}-signed-agreement.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("leases")
    .upload(leasePath, Buffer.from(await pdfBlob.arrayBuffer()), {
      contentType: "application/pdf",
    });
  if (uploadError) return { attached: false, reason: uploadError.message };

  // A newly signed agreement supersedes whatever was on file.
  const { error: updateError } = await supabase
    .from("tenancies")
    .update({ lease_pdf_path: leasePath })
    .eq("id", tenancy.id);
  if (updateError) {
    await supabase.storage.from("leases").remove([leasePath]);
    return { attached: false, reason: updateError.message };
  }

  // The unsigned placeholder is now redundant; any other previous lease PDF
  // is left in the bucket rather than deleted.
  if (isUnsignedLeasePath(tenancy.lease_pdf_path)) {
    await supabase.storage.from("leases").remove([tenancy.lease_pdf_path!]);
  }

  await supabase
    .from("agreement_requests")
    .update({
      assigned_tenancy_id: tenancy.id,
      assigned_at: new Date().toISOString(),
    })
    .eq("id", request.id);

  return { attached: true, tenancyId: tenancy.id, tenantId: tenancy.tenant_id };
}
