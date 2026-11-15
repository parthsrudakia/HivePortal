/**
 * Group-text nudge for an agreement that keeps going unsigned.
 *
 * When a signing request's email goes out for the 3rd time (first send + two
 * resends) and the recipient is a current tenant (an active tenancy), one
 * group text goes to the tenant and the office number asking them to sign,
 * followed by the signing link as its own message. Sent at most once per request (nudge_texted_at); if
 * it can't go out on the 3rd send (no phone, SMS down) a later resend retries.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms } from "@/lib/sms";

/** The send that triggers the text. */
export const AGREEMENT_NUDGE_AT_SEND = 3;
/** Office number added to every nudge thread. */
export const AGREEMENT_NUDGE_CC = "5857322019";

/** The message text; the signing link follows as its own message so it
 *  arrives whole and tappable. */
export function agreementNudgeText(tenantName: string): string {
  const firstName = tenantName.trim().split(/\s+/)[0] || "there";
  return `Hi ${firstName}, your lease agreement is still unsigned. We've emailed it to you a few times now (check your spam folder too), or you can sign it using the link in the next message. Please sign it today, and reply here if you're having any trouble with it.`;
}

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type NudgeRequest = {
  id: string;
  tenant_name: string;
  recipient_email: string;
  assigned_tenancy_id: string | null;
  send_count: number;
  nudge_texted_at: string | null;
  /** The signing link that just went out by email. */
  sign_url: string;
};

export type NudgeResult =
  | { texted: true }
  | { texted: false; reason: string };

/**
 * The current tenant an agreement request is for: the linked tenancy's tenant
 * if it's active, else the single tenant (by email, falling back to exact
 * name) holding an active tenancy. Ambiguous matches return null.
 */
async function currentTenantFor(
  supabase: SupabaseClient,
  request: NudgeRequest,
): Promise<{ full_name: string; phone: string | null } | null> {
  if (request.assigned_tenancy_id) {
    const { data } = await supabase
      .from("tenancies")
      .select("status, tenants(full_name, phone)")
      .eq("id", request.assigned_tenancy_id)
      .maybeSingle();
    const tenant = Array.isArray(data?.tenants) ? data.tenants[0] : data?.tenants;
    return data?.status === "active" && tenant ? tenant : null;
  }

  const email = request.recipient_email.trim();
  const name = request.tenant_name.trim();
  const [byEmail, byName] = await Promise.all([
    email
      ? supabase.from("tenants").select("id").ilike("email", likeLiteral(email))
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
    name
      ? supabase.from("tenants").select("id").ilike("full_name", likeLiteral(name))
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ]);
  if (byEmail.error || byName.error) return null;
  const emailIds = (byEmail.data ?? []).map((t) => t.id);
  const ids = emailIds.length > 0 ? emailIds : (byName.data ?? []).map((t) => t.id);
  if (ids.length === 0) return null;

  const { data: active } = await supabase
    .from("tenancies")
    .select("tenant_id, tenants(full_name, phone)")
    .in("tenant_id", ids)
    .eq("status", "active");
  const tenantIds = new Set((active ?? []).map((t) => t.tenant_id));
  if (tenantIds.size !== 1) return null;
  const rel = active![0].tenants;
  return (Array.isArray(rel) ? rel[0] : rel) ?? null;
}

/**
 * Call after a successful send/resend with the request's new send_count.
 * Never throws — a failed nudge must not fail the resend.
 */
export async function maybeNudgeAgreement(
  supabase: SupabaseClient,
  request: NudgeRequest,
): Promise<NudgeResult> {
  try {
    if (request.send_count < AGREEMENT_NUDGE_AT_SEND)
      return { texted: false, reason: "below threshold" };
    if (request.nudge_texted_at) return { texted: false, reason: "already texted" };

    const tenant = await currentTenantFor(supabase, request);
    if (!tenant) return { texted: false, reason: "not a current tenant" };
    if (!tenant.phone?.trim()) return { texted: false, reason: "tenant has no phone" };

    const to = [tenant.phone, AGREEMENT_NUDGE_CC];
    const meta = {
      type: "agreement_nudge" as const,
      context: `${tenant.full_name} · agreement ${request.id}`,
    };
    const res = await sendSms(to, agreementNudgeText(tenant.full_name), meta);
    if (!res.ok) return { texted: false, reason: res.error };

    // The message is out, so mark the nudge done before the link goes:
    // a retry on a later resend would repeat the message to the tenant.
    await supabase
      .from("agreement_requests")
      .update({ nudge_texted_at: new Date().toISOString() })
      .eq("id", request.id);

    // The link on its own, so it isn't split across SMS segments.
    const link = await sendSms(to, request.sign_url, meta);
    if (!link.ok) {
      return { texted: false, reason: `message sent, link failed: ${link.error}` };
    }
    return { texted: true };
  } catch (e) {
    return { texted: false, reason: e instanceof Error ? e.message : "unexpected error" };
  }
}
