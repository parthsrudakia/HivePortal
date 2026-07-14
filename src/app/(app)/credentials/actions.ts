"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import type { Database } from "@/lib/supabase/types";

type Category = Database["public"]["Enums"]["credential_category"];
const VALID_CATEGORIES: Category[] = [
  "payment_portal",
  "maintenance_portal",
  "utility",
  "internet",
  "building_login",
  "other",
];

export type CredentialFormState = { error?: string } | undefined;

const LEDGER_ADMIN_ERROR =
  "Only Parth or Vineet can manage credentials.";

// The credentials vault is admin-managed. Every mutation is gated here as
// defense-in-depth on top of the RLS policy that restricts writes to the two
// operators (see 20260716095000_credentials_write_rls_and_plaintext_block).
async function requireMaster(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isMaster(user?.email) ? null : LEDGER_ADMIN_ERROR;
}

type CredentialValues = {
  category: Category;
  service_name: string;
  property_id: string | null;
  username: string | null;
  password: string | null;
  login_url: string | null;
  account_number: string | null;
  owner_label: string | null;
  notes: string | null;
};

function parse(formData: FormData): CredentialValues | { error: string } {
  const category = String(formData.get("category") ?? "") as Category;
  if (!VALID_CATEGORIES.includes(category))
    return { error: "Pick a category." };

  const service_name = String(formData.get("service_name") ?? "").trim();
  if (!service_name) return { error: "Service name is required." };

  const strOrNull = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  return {
    category,
    service_name,
    property_id: strOrNull("property_id"),
    username: strOrNull("username"),
    password: strOrNull("password"),
    login_url: strOrNull("login_url"),
    account_number: strOrNull("account_number"),
    owner_label: strOrNull("owner_label"),
    notes: strOrNull("notes"),
  };
}

export async function createCredential(
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const denied = await requireMaster(supabase);
  if (denied) return { error: denied };

  // Insert the row without the plaintext password (the DB trigger nulls it
  // regardless); the secret is then encrypted via set_credential_password.
  const { password, ...rest } = parsed;
  const { data: created, error } = await supabase
    .from("credentials")
    .insert(rest)
    .select("id")
    .single();

  if (error) return { error: error.message };

  if (password && created?.id) {
    const { error: pwErr } = await supabase.rpc("set_credential_password", {
      cred_id: created.id,
      plaintext: password,
    });
    if (pwErr) return { error: pwErr.message };
  }

  revalidatePath("/credentials");
  return undefined;
}

export async function updateCredential(
  id: string,
  _prev: CredentialFormState,
  formData: FormData,
): Promise<CredentialFormState> {
  const parsed = parse(formData);
  if ("error" in parsed) return parsed;

  const supabase = await createClient();
  const denied = await requireMaster(supabase);
  if (denied) return { error: denied };

  // Password is written only through the encrypting setter, and only when a new
  // value was entered (an empty field means "leave the stored secret as-is").
  const { password, ...rest } = parsed;
  const { error } = await supabase
    .from("credentials")
    .update(rest)
    .eq("id", id);

  if (error) return { error: error.message };

  if (password) {
    const { error: pwErr } = await supabase.rpc("set_credential_password", {
      cred_id: id,
      plaintext: password,
    });
    if (pwErr) return { error: pwErr.message };
  }

  revalidatePath("/credentials");
  return undefined;
}

export async function deleteCredential(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  if (await requireMaster(supabase)) return;
  await supabase.from("credentials").delete().eq("id", id);
  revalidatePath("/credentials");
}

/**
 * On-demand password reveal. The plaintext is never shipped with the page; the
 * client calls this only when an admin clicks Reveal/Copy. Gated to the two
 * operators (the DB function re-checks) and every reveal is logged.
 */
export async function revealCredential(
  credentialId: string,
): Promise<{ password: string | null } | { error: string }> {
  const supabase = await createClient();
  const denied = await requireMaster(supabase);
  if (denied) return { error: denied };

  const { data, error } = await supabase.rpc("credential_password", {
    cred_id: credentialId,
  });
  if (error) return { error: error.message };

  await logCredentialAccess(credentialId, "reveal");
  return { password: (data as string | null) ?? null };
}

export async function logCredentialAccess(
  credentialId: string,
  action: "reveal" | "copy",
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  await supabase.from("credential_access_log").insert({
    credential_id: credentialId,
    action,
    accessed_by: user?.id ?? null,
  });
}
