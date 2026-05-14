import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "../login/actions";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/properties", label: "Properties" },
  { href: "/inventory", label: "Inventory" },
  { href: "/tenants", label: "Tenants & Rent" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/reports", label: "Reports" },
  { href: "/cleaning", label: "Cleaning" },
  { href: "/marketing", label: "Marketing" },
  { href: "/credentials", label: "Credentials" },
  { href: "/settings/notifications", label: "Notifications" },
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

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-stone/60 bg-white/60 px-4 py-8 md:flex">
        <Link href="/" className="px-2 text-2xl tracking-tight text-ink">
          Hive <span className="font-display text-accent-text">Portal</span>
        </Link>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          {NAV.map((item) => (
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
