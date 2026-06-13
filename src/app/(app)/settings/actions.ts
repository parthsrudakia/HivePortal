"use server";

import { createClient } from "@/lib/supabase/server";

export type PasswordFormState =
  | { error?: string; success?: string }
  | undefined;

export async function changePassword(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");

  if (!current || !next || !confirm) {
    return { error: "All fields are required." };
  }
  if (next.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }
  if (next !== confirm) {
    return { error: "New passwords do not match." };
  }
  if (next === current) {
    return { error: "New password must differ from the current one." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { error: "You are not signed in." };
  }

  // Verify the current password by re-authenticating before allowing a change.
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (verifyError) {
    return { error: "Current password is incorrect." };
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    return { error: error.message };
  }

  return { success: "Password updated." };
}
