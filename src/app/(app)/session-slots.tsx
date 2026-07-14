import { cache } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { canViewProfitability, isMaster } from "@/lib/access";
import { NamePrompt } from "./name-prompt";
import { NavIcon } from "./nav-icons";

// Session-dependent fragments of the app shell. Each is rendered behind its
// own <Suspense> so the layout itself stays free of runtime data access —
// otherwise every navigation blocks until auth resolves and `loading.tsx`
// never shows (see the "Interaction with loading.js" caveat in
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md).

const getSessionUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

function displayNameOf(user: User | null): string {
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
  // board_tasks post-dates the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (supabase as any)
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
