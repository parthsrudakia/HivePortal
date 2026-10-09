"use server";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import {
  emergencyContactSchema,
  linkActive,
  selfContactError,
  TOKEN_PATTERN,
} from "@/lib/emergency-contact";

function admin() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitEmergencyContact(
  token: string,
  raw: unknown,
): Promise<SubmitResult> {
  const parsed = emergencyContactSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }

  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, error: "This link is no longer valid. Reply to the email you received for a new one." };
  }

  const supabase = admin();
  // Fresh token lookup: never trust the page render that got the tenant here.
  const { data: row, error: readError } = await supabase
    .from("emergency_contacts")
    .select("id, expires_at, tenants(email, phone)")
    .eq("token", token)
    .maybeSingle();
  if (readError) {
    console.error("[emergency-contact] lookup failed", readError);
    return { ok: false, error: "Something went wrong on our side. Please try again in a minute." };
  }
  if (!row || !linkActive(row.expires_at)) {
    return {
      ok: false,
      error: "This link has expired. Links are valid for 48 hours. Reply to the email you received for a new one.",
    };
  }

  const tenant = one(row.tenants);
  const selfError = tenant
    ? selfContactError(parsed.data, { email: tenant.email, phone: tenant.phone })
    : null;
  if (selfError) {
    const field = selfError.includes("email") ? "contactEmail" : "contactPhone";
    return { ok: false, error: selfError, fieldErrors: { [field]: selfError } };
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("emergency_contacts")
    .update({
      contact_name: parsed.data.contactName,
      relationship: parsed.data.relationship,
      contact_email: parsed.data.contactEmail,
      contact_phone: parsed.data.contactPhone,
      submitted_at: now,
      updated_at: now,
    })
    .eq("id", row.id);
  if (error) {
    console.error("[emergency-contact] save failed", error);
    return { ok: false, error: "Something went wrong on our side. Please try again in a minute." };
  }
  return { ok: true };
}
