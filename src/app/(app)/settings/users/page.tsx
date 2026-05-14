import { redirect } from "next/navigation";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isMaster } from "@/lib/access";
import { InviteUserForm } from "./invite-form";
import { deleteUser } from "./actions";

export const dynamic = "force-dynamic";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function UsersPage() {
  const supabase = await createClient();
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  if (!isMaster(currentUser?.email)) {
    redirect("/");
  }

  const { data, error } = await adminClient().auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  const users = data?.users ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Users</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Invite people to the portal. They&apos;ll get an email with a link to
          set a password. Everyone has full access except Reports and Audit log,
          which are master-only.
        </p>
      </header>

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Invite user
        </h2>
        <div className="mt-3">
          <InviteUserForm />
        </div>
      </section>

      {error && (
        <p className="mt-6 text-sm text-red-700">{error.message}</p>
      )}

      <section className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
        <table className="w-full text-sm">
          <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Invited</th>
              <th className="px-4 py-2 font-medium">Last sign-in</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-sm text-muted"
                >
                  No users yet.
                </td>
              </tr>
            )}
            {users.map((u, i) => {
              const isCurrent = u.id === currentUser?.id;
              const master = isMaster(u.email);
              const pending = !u.last_sign_in_at;
              return (
                <tr
                  key={u.id}
                  className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
                >
                  <td className="px-4 py-2.5 text-ink">
                    {u.email ?? "—"}
                    {isCurrent && (
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-muted">
                        (you)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {fmtWhen(u.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {pending ? (
                      <span className="rounded-full bg-warm px-2 py-0.5 text-[11px] uppercase tracking-wide text-ink/70">
                        Invite pending
                      </span>
                    ) : (
                      fmtWhen(u.last_sign_in_at)
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {master ? (
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-text">
                        Master
                      </span>
                    ) : (
                      <span className="rounded-full border border-stone bg-white px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
                        Standard
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!isCurrent && !master && (
                      <form action={deleteUser}>
                        <input type="hidden" name="user_id" value={u.id} />
                        <button
                          type="submit"
                          className="rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-red-700 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
