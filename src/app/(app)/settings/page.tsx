import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

type AdminLink = {
  href: string;
  title: string;
  description: string;
  masterOnly?: boolean;
};

const ADMIN_LINKS: AdminLink[] = [
  {
    href: "/reports",
    title: "Reports",
    description: "Portfolio financials, collections, and occupancy reporting.",
    masterOnly: true,
  },
  {
    href: "/settings/users",
    title: "Users",
    description: "Invite teammates and manage who can access the portal.",
    masterOnly: true,
  },
  {
    href: "/settings/notifications",
    title: "Notification settings",
    description:
      "Manage who gets emailed on room status and listing-action changes.",
    masterOnly: true,
  },
  {
    href: "/settings/audit-log",
    title: "Audit log",
    description: "Review every change made across the portal.",
  },
  {
    href: "/settings/email-log",
    title: "Email log",
    description: "Every email the portal has sent, filterable by type and status.",
  },
  {
    href: "/settings/sms-log",
    title: "Text log",
    description: "Every text the portal has sent, filterable by type and status.",
  },
  {
    href: "/settings/telegram-log",
    title: "Telegram bot log",
    description:
      "Every bot turn — user messages, tool calls, results, and errors — for diagnosing what went wrong.",
    masterOnly: true,
  },
];

export default async function AdminSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const master = isMaster(user?.email);
  const visibleLinks = ADMIN_LINKS.filter((l) => !l.masterOnly || master);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          Admin <span className="font-display text-accent-text">Settings</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Account security and portal administration.
        </p>
      </header>

      {visibleLinks.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Administration
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {visibleLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group flex flex-col gap-1 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-stone/40 transition hover:ring-accent/50"
              >
                <span className="flex items-center justify-between text-base font-medium text-ink">
                  {link.title}
                  <span className="text-muted transition group-hover:text-accent-text">
                    →
                  </span>
                </span>
                <span className="text-sm text-muted">{link.description}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Change password
        </h2>
        <p className="mt-1 text-sm text-muted">
          Signed in as {user?.email ?? "—"}.
        </p>
        <div className="mt-4 max-w-sm">
          <ChangePasswordForm />
        </div>
      </section>
    </div>
  );
}
