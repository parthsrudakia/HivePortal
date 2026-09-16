import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type ResolvedRecipient =
  | { ok: true; phone: string; tenantName: string | null }
  | { ok: false; error: string };

/**
 * Turn operator input into a phone number. Anything with 10+ digits is taken
 * as a phone number as-is; anything else is treated as a tenant name and must
 * match exactly one tenant with a phone on file. Shared by the bot's texting
 * tools and the Text log's opt-out lookup so both resolve names the same way.
 */
export async function resolveRecipientPhone(
  supabase: SupabaseClient<Database>,
  input: string,
): Promise<ResolvedRecipient> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "No recipient given." };
  if (raw.replace(/\D/g, "").length >= 10) {
    return { ok: true, phone: raw, tenantName: null };
  }
  const { data: matches, error } = await supabase
    .from("tenants")
    .select("full_name, phone")
    .ilike("full_name", `%${raw}%`);
  if (error) return { ok: false, error: error.message };
  if (!matches || matches.length === 0) {
    return { ok: false, error: `No tenant found matching "${raw}".` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${raw}" matches ${matches.length} tenants (${matches
        .map((m) => m.full_name)
        .join(", ")}) — be more specific.`,
    };
  }
  const phone = matches[0].phone?.trim();
  if (!phone) {
    return { ok: false, error: `${matches[0].full_name} has no phone on file.` };
  }
  return { ok: true, phone, tenantName: matches[0].full_name };
}
