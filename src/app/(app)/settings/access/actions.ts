"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { getSessionUser } from "@/lib/session";
import { isMaster } from "@/lib/access";
import { isPortalPermission, isPortalSection } from "@/lib/section-access";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AccessResult = { error?: string; success?: string };

/**
 * Saves one user's access: the sections they're blocked from (deny-list)
 * and the extra permissions they're granted (allow-list). Vineet-only
 * (isMaster) — the page already redirects everyone else; this closes the
 * direct server-action path. Vineet himself can't be restricted.
 */
export async function setUserAccess(
  userId: string,
  blocked: string[],
  granted: string[],
): Promise<AccessResult> {
  const me = await getSessionUser();
  if (!me || !isMaster(me.email)) return { error: "Forbidden." };
  if (!userId) return { error: "Missing user." };

  const admin = adminClient();
  const { data: target, error: userErr } =
    await admin.auth.admin.getUserById(userId);
  if (userErr || !target.user) return { error: "User not found." };
  if (isMaster(target.user.email)) {
    return { error: "Vineet always has full access." };
  }

  const blockedSections = blocked.filter(isPortalSection);
  const grantedPermissions = granted.filter(isPortalPermission);
  if (
    blockedSections.length !== blocked.length ||
    grantedPermissions.length !== granted.length
  ) {
    return { error: "Unknown section or permission." };
  }

  const { error } = await admin.from("user_section_access").upsert({
    user_id: userId,
    blocked_sections: blockedSections,
    granted_permissions: grantedPermissions,
    updated_at: new Date().toISOString(),
    updated_by: me.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/access");
  return { success: "Access updated." };
}
