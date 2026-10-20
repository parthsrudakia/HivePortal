import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/access";

/**
 * Per-user section access, set by Vineet (isMaster) from Settings →
 * Access control. Stored as a deny-list in `user_section_access`, so a user
 * with no row has full access. The operators (Vineet + Parth) are never
 * restricted — their operator powers are hard-coded and mirrored in RLS.
 *
 * Keys are stored in the DB; keep them stable (the migration comment
 * references this list).
 */
export const PORTAL_SECTIONS = [
  { key: "properties", label: "Properties", href: "/properties" },
  { key: "projects", label: "Projects", href: "/projects" },
  { key: "inventory", label: "Inventory", href: "/inventory" },
  { key: "tenants", label: "Rent Tracker", href: "/tenants" },
  { key: "reconciliation", label: "Reconciliation", href: "/reconciliation" },
  { key: "cleaning", label: "Cleaning", href: "/cleaning" },
  { key: "utilities", label: "Utilities", href: "/utilities" },
  { key: "agreements", label: "Agreements", href: "/agreements" },
] as const;

export type PortalSection = (typeof PORTAL_SECTIONS)[number]["key"];

const SECTION_KEYS = new Set<string>(PORTAL_SECTIONS.map((s) => s.key));

export function isPortalSection(key: string): key is PortalSection {
  return SECTION_KEYS.has(key);
}

/** Section key for a nav href ("/tenants" → "tenants"), or null if ungated. */
export function sectionForHref(href: string): PortalSection | null {
  return PORTAL_SECTIONS.find((s) => s.href === href)?.key ?? null;
}

/** Sections the signed-in user is blocked from (empty for operators). */
export const getBlockedSections = cache(
  async (): Promise<Set<PortalSection>> => {
    const user = await getSessionUser();
    if (!user || isOperator(user.email)) return new Set();

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_section_access")
      .select("blocked_sections")
      .eq("user_id", user.id)
      .maybeSingle();
    // Fail closed: if we can't read the restrictions, don't silently grant
    // everything.
    if (error) throw new Error(`Couldn't load section access: ${error.message}`);
    return new Set((data?.blocked_sections ?? []).filter(isPortalSection));
  },
);

/** Page/layout guard: bounce the user to the dashboard if blocked. */
export async function requireSection(section: PortalSection): Promise<void> {
  const blocked = await getBlockedSections();
  if (blocked.has(section)) redirect("/");
}

/**
 * Server-action guard. Pages are already gated by each section's layout;
 * this closes the direct-invocation path. Passes when the user may use ANY
 * of the given sections — a few actions are shared (e.g. Reconciliation
 * posts charges through the Rent Tracker actions). Throws rather than
 * returning, since the action return shapes vary and the UI never offers a
 * blocked action in the first place.
 */
export async function assertSection(
  ...sections: [PortalSection, ...PortalSection[]]
): Promise<void> {
  const blocked = await getBlockedSections();
  if (sections.every((s) => blocked.has(s))) {
    throw new Error("You don't have access to this section.");
  }
}
