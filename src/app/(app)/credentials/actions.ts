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
  const { error } = await supabase.from("credentials").insert(parsed);

  if (error) return { error: error.message };

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Only admins may set or change a password. For everyone else, drop it from
  // the update so a non-admin edit can never read, overwrite, or clear it.
  let update: Partial<CredentialValues> = parsed;
  if (!isMaster(user?.email)) {
    update = { ...parsed };
    delete update.password;
  }

  const { error } = await supabase
    .from("credentials")
    .update(update)
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/credentials");
  return undefined;
}

export async function deleteCredential(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  await supabase.from("credentials").delete().eq("id", id);
  revalidatePath("/credentials");
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
