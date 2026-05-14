"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertMaster() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isMaster(user?.email)) {
    throw new Error("Forbidden");
  }
}

export type InviteFormState =
  | { error?: string; success?: string }
  | undefined;

export async function inviteUser(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  await assertMaster();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Email is required." };
  if (!email.includes("@")) return { error: "That doesn't look like an email." };

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://hive-portal-1485.vercel.app";
  const { error } = await admin().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/accept-invite`,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/users");
  return { success: `Invite sent to ${email}.` };
}

export async function deleteUser(formData: FormData) {
  await assertMaster();

  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return;

  await admin().auth.admin.deleteUser(userId);
  revalidatePath("/settings/users");
}
