import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { logout } from "../login/actions";

type NavItem = { href: string; label: string; masterOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/properties", label: "Properties" },
  { href: "/inventory", label: "Inventory" },
  { href: "/tenants", label: "Tenants & Rent" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/reports", label: "Reports", masterOnly: true },
  { href: "/cleaning", label: "Cleaning" },
  { href: "/marketing", label: "Marketing" },
  { href: "/credentials", label: "Credentials" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/audit-log", label: "Audit log", masterOnly: true },
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
  const navItems = NAV.filter((item) => !item.masterOnly || master);

  return (
    <div className="flex min-h-full">
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
          <span>
            Hive <span className="font-display text-accent-text">Portal</span>
          </span>
        </Link>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-ink/80 transition hover:bg-warm hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-3 pt-6 text-xs text-muted">
          <p className="truncate">{user?.email ?? "—"}</p>
          <form action={logout} className="mt-2">
            <button
              type="submit"
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 px-6 py-8 md:px-10 md:py-12">{children}</main>
    </div>
  );
}
