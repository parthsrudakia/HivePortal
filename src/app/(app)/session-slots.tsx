import { cache } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { canViewProfitability, isMaster, isOperator } from "@/lib/access";
import { NamePrompt } from "./name-prompt";
import { NavIcon } from "./nav-icons";
import { AssistantWidget, AssistantLauncher } from "./assistant-widget";

// Session-dependent fragments of the app shell. Each is rendered behind its
// own <Suspense> so the layout itself stays free of runtime data access —
// otherwise every navigation blocks until auth resolves and `loading.tsx`
// never shows (see the "Interaction with loading.js" caveat in
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md).

function displayNameOf(user: SessionUser | null): string {
  if (!user) return "";
  return typeof user.user_metadata?.display_name === "string"
    ? user.user_metadata.display_name.trim()
    : typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";
}

export async function AuthGate() {
  const user = await getSessionUser();

  // Defensive backup to the proxy: never render the app shell for an
  // unauthenticated user, even if proxy.ts doesn't fire for any reason.
  if (!user) {
    redirect("/login");
  }

  return displayNameOf(user) ? null : <NamePrompt />;
}

// Projects nav badge: for the admin, tasks awaiting review or flagged for
// attention; for members, their unseen ("New") assignments.
const getProjectsBadgeCount = cache(async (): Promise<number> => {
  const user = await getSessionUser();
  if (!user) return 0;

  const supabase = await createClient();
  const q = supabase
    .from("board_tasks")
    .select("id", { count: "exact", head: true });
  const { count } = isMaster(user.email)
    ? await q.or("status.eq.pending_review,needs_attention.eq.true")
    : await q
        .eq("assigned_to", user.id)
        .eq("seen_by_assignee", false)
        .neq("status", "completed");
  return count ?? 0;
});

export async function ProjectsBadge({ className }: { className: string }) {
  const count = await getProjectsBadgeCount();
  if (!count) return null;
  return <span className={className}>{count > 99 ? "99+" : count}</span>;
}

/**
 * Owner-only "Profitability" nav entry — renders nothing for everyone else.
 * Styling comes from the caller so the same slot fits the desktop sidebar
 * and the mobile drawer.
 */
export async function ProfitabilityNavLink({
  className,
  iconClassName,
}: {
  className: string;
  iconClassName: string;
}) {
  const user = await getSessionUser();
  if (!canViewProfitability(user?.email)) return null;
  return (
    <Link href="/profitability" className={className}>
      <NavIcon name="profitability" className={iconClassName} />
      Profitability
    </Link>
  );
}

/**
 * Operator-only "Developers" nav entry (API docs) — renders nothing for
 * everyone else. Same slot pattern as ProfitabilityNavLink. Used in the
 * mobile drawer, where the icon-buttons header doesn't exist.
 */
export async function DevelopersNavLink({
  className,
  iconClassName,
}: {
  className: string;
  iconClassName: string;
}) {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) return null;
  return (
    <Link href="/developers" className={className}>
      <NavIcon name="developers" className={iconClassName} />
      Developers
    </Link>
  );
}

/**
 * Icon-only Developers link for the desktop header, beside the settings
 * gear. Same operator gate as the drawer entry.
 */
export async function DevelopersHeaderLink() {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) return null;
  return (
    <Link
      href="/developers"
      aria-label="Developers"
      title="Developers — API docs"
      className="flex h-9 w-9 items-center justify-center rounded-lg text-ink transition hover:bg-warm hover:text-accent-text"
    >
      <NavIcon name="developers" />
    </Link>
  );
}

/**
 * The in-portal ops-assistant chat — same bot as Telegram. Operator-only
 * (Vineet & Parth), same gate as the Developers link. Renders nothing for
 * everyone else, so the widget never mounts for non-operators.
 */
export async function AssistantSlot() {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) return null;
  return <AssistantWidget />;
}

/** Header launcher icon (beside Developers) — operator-only, same gate. */
export async function AssistantHeaderLink() {
  const user = await getSessionUser();
  if (!isOperator(user?.email)) return null;
  return <AssistantLauncher />;
}

export async function UserIdentity() {
  const user = await getSessionUser();
  const displayName = displayNameOf(user);
  return (
    <span
      className="max-w-[200px] truncate text-sm text-ink"
      title={displayName || user?.email || undefined}
    >
      {displayName || user?.email || "—"}
    </span>
  );
}

export async function MobileUserInfo() {
  const user = await getSessionUser();
  const displayName = displayNameOf(user);
  const email = user?.email ?? null;
  if (!displayName && !email) return null;
  return (
    <div className="mt-auto px-3 pt-6 text-xs text-ink/80">
      {displayName && (
        <p className="truncate font-medium text-ink">{displayName}</p>
      )}
      {email && <p className="truncate text-ink/60">{email}</p>}
    </div>
  );
}
