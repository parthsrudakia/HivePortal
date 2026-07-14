import { Suspense } from "react";
import Link from "next/link";
import { logout } from "../login/actions";
import { MobileNav } from "./mobile-nav";
import { CommandPalette } from "./command-palette";
import { NavIcon, type NavIconName } from "./nav-icons";
import {
  AuthGate,
  MobileUserInfo,
  ProfitabilityNavLink,
  ProjectsBadge,
  UserIdentity,
} from "./session-slots";

type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
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

// This layout must stay synchronous with no runtime data access (cookies,
// auth, queries) — anything session-dependent streams in via the
// <Suspense>-wrapped slots from session-slots.tsx. Otherwise every
// navigation blocks on auth before `loading.tsx` can appear.
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Suspense>
        <AuthGate />
      </Suspense>
      <MobileNav
        items={NAV}
        extraNav={
          <Suspense>
            <ProfitabilityNavLink
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink transition hover:bg-warm hover:text-ink"
              iconClassName="shrink-0 text-accent"
            />
          </Suspense>
        }
        badges={{
          "/projects": (
            <Suspense>
              <ProjectsBadge className="ml-auto rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white" />
            </Suspense>
          ),
        }}
        userInfo={
          <Suspense>
            <MobileUserInfo />
          </Suspense>
        }
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
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink transition hover:bg-warm hover:text-ink"
            >
              <NavIcon name={item.icon} className="shrink-0 text-accent" />
              {item.label}
              {item.href === "/projects" && (
                <Suspense>
                  <ProjectsBadge className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white" />
                </Suspense>
              )}
            </Link>
          ))}
          <Suspense>
            <ProfitabilityNavLink
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink transition hover:bg-warm hover:text-ink"
              iconClassName="shrink-0 text-accent"
            />
          </Suspense>
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
          <Suspense
            fallback={
              <span className="h-4 w-28 animate-pulse rounded bg-warm" />
            }
          >
            <UserIdentity />
          </Suspense>
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
