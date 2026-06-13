import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { logout } from "../login/actions";
import { MobileNav } from "./mobile-nav";
import { CommandPalette } from "./command-palette";
import { NavIcon, type NavIconName } from "./nav-icons";

type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  masterOnly?: boolean;
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/inventory", label: "Inventory", icon: "inventory" },
  { href: "/tenants", label: "Tenants & Rent", icon: "tenants" },
  { href: "/reconciliation", label: "Reconciliation", icon: "reconciliation" },
  { href: "/cleaning", label: "Cleaning", icon: "cleaning" },
  { href: "/credentials", label: "Credentials", icon: "credentials" },
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
    <div className="flex min-h-full flex-col md:flex-row">
      <MobileNav items={navItems} userEmail={user.email ?? null} />
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
          <span>
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
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 hidden items-center justify-end gap-3 border-b border-stone/60 bg-cream/90 px-10 py-3 backdrop-blur md:flex">
          <Link
            href="/settings/notifications"
            aria-label="Notifications"
            title="Notifications"
            className="rounded-lg p-2 text-ink transition hover:bg-warm hover:text-accent-text"
          >
            <NavIcon name="notifications" />
          </Link>
          <Link
            href="/settings"
            aria-label="Admin Settings"
            title="Admin Settings"
            className="rounded-lg p-2 text-ink transition hover:bg-warm hover:text-accent-text"
          >
            <NavIcon name="settings" />
          </Link>
          <span className="mx-1 h-5 w-px bg-stone/60" aria-hidden="true" />
          <span className="truncate text-xs text-ink">
            {user?.email ?? "—"}
          </span>
          <form action={logout}>
            <button
              type="submit"
              className="text-xs uppercase tracking-wide text-ink hover:text-accent-text"
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
