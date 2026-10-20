import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { isMaster, isOperator } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { PORTAL_SECTIONS } from "@/lib/section-access";
import { SectionToggles } from "./section-toggles";

export const dynamic = "force-dynamic";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function profileName(meta: Record<string, unknown> | undefined): string | null {
  const pick = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return pick(meta?.display_name) ?? pick(meta?.full_name);
}

export default async function AccessControlPage() {
  const currentUser = await getSessionUser();
  if (!isMaster(currentUser?.email)) redirect("/");

  const admin = adminClient();
  const [{ data: usersData, error: usersErr }, { data: rows, error: rowsErr }] =
    await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      admin.from("user_section_access").select("user_id, blocked_sections"),
    ]);
  // Don't render toggles from a partial read — a missing row would show a
  // restricted user as having full access.
  if (usersErr) throw new Error(`Couldn't load users: ${usersErr.message}`);
  if (rowsErr) throw new Error(`Couldn't load access: ${rowsErr.message}`);

  const blockedByUser = new Map(
    (rows ?? []).map((r) => [r.user_id, r.blocked_sections]),
  );
  const users = (usersData?.users ?? [])
    .map((u) => ({
      id: u.id,
      email: u.email ?? "—",
      name: profileName(u.user_metadata),
      operator: isOperator(u.email),
      blocked: blockedByUser.get(u.id) ?? [],
    }))
    .sort(
      (a, b) =>
        Number(b.operator) - Number(a.operator) ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );
  const sections = PORTAL_SECTIONS.map(({ key, label }) => ({ key, label }));

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          Access <span className="font-display text-accent-text">Control</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Choose which sections each teammate can open. Unchecked sections
          disappear from their navigation and redirect to the dashboard.
          Changes save instantly. New users start with full access.
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        {users.map((u) => (
          <div key={u.id} className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-base font-medium text-ink">
                  {u.name ?? u.email}
                  {u.id === currentUser?.id && (
                    <span className="ml-2 text-xs uppercase tracking-wide text-muted">
                      (you)
                    </span>
                  )}
                </p>
                {u.name && (
                  <p className="truncate text-xs text-muted">{u.email}</p>
                )}
              </div>
              {u.operator && (
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-text">
                  Operator · full access
                </span>
              )}
            </div>
            {!u.operator && (
              <div className="mt-3">
                <SectionToggles
                  userId={u.id}
                  sections={sections}
                  initialBlocked={u.blocked}
                />
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
