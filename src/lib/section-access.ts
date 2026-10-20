import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { isMaster } from "@/lib/access";

/**
 * Per-user portal access, set by Vineet (isMaster) from Settings → Access
 * control and stored in `user_section_access`:
 *
 * - **Sections** are a deny-list (`blocked_sections`): everyone gets every
 *   section until Vineet unticks one.
 * - **Permissions** are an allow-list (`granted_permissions`): the extras
 *   nobody has until Vineet grants them.
 *
 * Vineet always has everything. Permissions are mirrored in Postgres by
 * `has_portal_permission()` (and `is_financial_operator()` = 'ledger'), so
 * RLS follows the same toggles — see 20261020143302_portal_permissions.
 *
 * Keys are stored in the DB; keep them stable.
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

export const PORTAL_PERMISSIONS = [
  {
    key: "credentials",
    label: "Credentials",
    description: "See, reveal, add and edit stored logins.",
  },
  {
    key: "profitability",
    label: "Profitability",
    description: "Per-unit P&L and its line items.",
  },
  {
    key: "ledger",
    label: "Financial edits",
    description:
      "Ledger charges/credits, refunds, reconciliation, utility posting, and adding/editing tenants, tenancies and properties.",
  },
  {
    key: "logs",
    label: "Admin logs",
    description: "Audit, email, text and Telegram logs.",
  },
  {
    key: "notifications",
    label: "Notification settings",
    description: "Choose who gets room-change emails.",
  },
  {
    key: "developers",
    label: "Developers",
    description: "API docs for the internal integrations.",
  },
  {
    key: "assistant",
    label: "Ops assistant",
    description:
      "The in-portal assistant chat. It acts with full portal access, so grant it carefully.",
  },
] as const;

export type PortalSection = (typeof PORTAL_SECTIONS)[number]["key"];
export type PortalPermission = (typeof PORTAL_PERMISSIONS)[number]["key"];

const SECTION_KEYS = new Set<string>(PORTAL_SECTIONS.map((s) => s.key));
const PERMISSION_KEYS = new Set<string>(PORTAL_PERMISSIONS.map((p) => p.key));

export function isPortalSection(key: string): key is PortalSection {
  return SECTION_KEYS.has(key);
}

export function isPortalPermission(key: string): key is PortalPermission {
  return PERMISSION_KEYS.has(key);
}

/** Section key for a nav href ("/tenants" → "tenants"), or null if ungated. */
export function sectionForHref(href: string): PortalSection | null {
  return PORTAL_SECTIONS.find((s) => s.href === href)?.key ?? null;
}

type Access = {
  master: boolean;
  blocked: Set<PortalSection>;
  granted: Set<PortalPermission>;
};

/** The signed-in user's access, read once per request. */
const getAccess = cache(async (): Promise<Access> => {
  const user = await getSessionUser();
  if (!user) return { master: false, blocked: new Set(), granted: new Set() };
  if (isMaster(user.email)) {
    return {
      master: true,
      blocked: new Set(),
      granted: new Set(PERMISSION_KEYS as Set<PortalPermission>),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_section_access")
    .select("blocked_sections, granted_permissions")
    .eq("user_id", user.id)
    .maybeSingle();
  // Fail closed: if we can't read the restrictions, don't silently grant
  // everything.
  if (error) throw new Error(`Couldn't load access: ${error.message}`);
  return {
    master: false,
    blocked: new Set((data?.blocked_sections ?? []).filter(isPortalSection)),
    granted: new Set(
      (data?.granted_permissions ?? []).filter(isPortalPermission),
    ),
  };
});

/** Sections the signed-in user is blocked from (empty for Vineet). */
export async function getBlockedSections(): Promise<Set<PortalSection>> {
  return (await getAccess()).blocked;
}

/** Whether the signed-in user holds `permission` (always true for Vineet). */
export async function hasPermission(
  permission: PortalPermission,
): Promise<boolean> {
  return (await getAccess()).granted.has(permission);
}

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
