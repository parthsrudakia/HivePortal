"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type CleanerFormState = { error?: string } | undefined;

export async function addCleaner(
  _prev: CleanerFormState,
  formData: FormData,
): Promise<CleanerFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim() || null;
  if (!name) return { error: "Name is required." };
  if (!email) return { error: "Email is required." };
  if (!email.includes("@")) return { error: "That doesn't look like an email." };

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("cleaners")
    .insert({ name, email, phone, enabled: true });
  if (error) return { error: error.message };

  revalidatePath("/settings/cleaners");
  return undefined;
}

export async function toggleCleaner(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  if (!id) return;

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("cleaners")
    .update({ enabled: !enabled })
    .eq("id", id);

  revalidatePath("/settings/cleaners");
}

export async function deleteCleaner(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("cleaners").delete().eq("id", id);

  revalidatePath("/settings/cleaners");
  revalidatePath("/properties");
}
