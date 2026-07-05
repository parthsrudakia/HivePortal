import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { logout } from "../login/actions";
import { MobileNav } from "./mobile-nav";
import { CommandPalette } from "./command-palette";
import { NamePrompt } from "./name-prompt";
import { NavIcon, type NavIconName } from "./nav-icons";

type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  masterOnly?: boolean;
  badge?: number;
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/projects", label: "Projects", icon: "projects" },
  { href: "/inventory", label: "Inventory", icon: "inventory" },
  { href: "/tenants", label: "Rent Tracker", icon: "tenants" },
  { href: "/reconciliation", label: "Reconciliation", icon: "reconciliation" },
  { href: "/cleaning", label: "Cleaning", icon: "cleaning" },
  { href: "/utilities", label: "Utilities", icon: "utilities" },
  { href: "/credentials", label: "Credentials", icon: "credentials" },
  { href: "/agreements", label: "Agreements", icon: "agreements" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defensive backup to the proxy: never render the app shell for an
  // unauthenticated user, even if proxy.ts doesn't fire for any reason.
  if (!user) {
    redirect("/login");
  }

  const master = isMaster(user.email);

  // Projects nav badge: for the admin, tasks awaiting review or flagged for
  // attention; for members, their unseen ("New") assignments.
  let projectsBadge = 0;
  {
    // board_tasks post-dates the generated types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (supabase as any)
      .from("board_tasks")
      .select("id", { count: "exact", head: true });
    const { count } = master
      ? await q.or("status.eq.pending_review,needs_attention.eq.true")
      : await q
          .eq("assigned_to", user.id)
          .eq("seen_by_assignee", false)
          .neq("status", "completed");
    projectsBadge = count ?? 0;
  }

  const navItems = NAV.map((item) =>
    item.href === "/projects" ? { ...item, badge: projectsBadge } : item,
  ).filter((item) => !item.masterOnly || master);

  const displayName =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name.trim()
      : typeof user.user_metadata?.full_name === "string"
        ? user.user_metadata.full_name.trim()
        : "";

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {!displayName && <NamePrompt />}
      <MobileNav
        items={navItems}
        userEmail={user.email ?? null}
        userName={displayName || null}
      />
      <CommandPalette />
      <aside className="hidden w-64 shrink-0 flex-col border-r border-stone/60 bg-white/60 px-4 py-8 md:flex">
        <Link
          href="/"
          className="flex items-center gap-2 px-2 text-2xl tracking-tight text-ink"
        >
          <svg
            width="24"
            height="30"
            viewBox="0 0 80 100"
            xmlns="http://www.w3.org/2000/svg"
            className="shrink-0 text-accent"
            aria-hidden="true"
          >
            <circle cx="40" cy="8" r="4.5" fill="currentColor" />
            <rect x="28" y="18" width="24" height="6" rx="3" fill="currentColor" />
            <rect x="18" y="32" width="44" height="6" rx="3" fill="currentColor" />
            <rect x="15" y="46" width="50" height="6" rx="3" fill="currentColor" />
            <rect x="18" y="60" width="44" height="6" rx="3" fill="currentColor" />
            <rect x="28" y="74" width="24" height="6" rx="3" fill="currentColor" />
            <circle cx="40" cy="88" r="4" fill="currentColor" />
          </svg>
          <span className="font-serif font-bold">
            Hive <span className="font-display text-accent-text">Portal</span>
          </span>
        </Link>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink transition hover:bg-warm hover:text-ink"
            >
              <NavIcon name={item.icon} className="shrink-0 text-accent" />
              {item.label}
              {!!item.badge && (
                <span className="ml-auto rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 hidden h-14 items-center justify-end gap-3 border-b border-stone/60 bg-cream/90 px-10 backdrop-blur md:flex">
          <Link
            href="/settings"
            aria-label="Admin Settings"
            title="Admin Settings"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink transition hover:bg-warm hover:text-accent-text"
          >
            <NavIcon name="settings" />
          </Link>
          <span className="h-5 w-px bg-stone/60" aria-hidden="true" />
          <span
            className="max-w-[200px] truncate text-sm text-ink"
            title={displayName || user?.email || undefined}
          >
            {displayName || user?.email || "—"}
          </span>
          <form action={logout} className="flex">
            <button
              type="submit"
              className="whitespace-nowrap rounded-full border border-stone bg-white px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-ink transition hover:border-accent hover:text-accent-text"
            >
              Sign out
            </button>
          </form>
        </header>
        <main className="flex-1 px-4 py-6 md:px-10 md:py-12">{children}</main>
      </div>
    </div>
  );
}
