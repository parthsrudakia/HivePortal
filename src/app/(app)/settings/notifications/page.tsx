import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/date";
import { AddRecipientForm } from "./add-form";
import { toggleRecipient, deleteRecipient } from "./actions";

export const dynamic = "force-dynamic";

type Recipient = {
  id: string;
  email: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
};

export default async function NotificationsPage() {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("notification_recipients")
    .select("id, email, label, enabled, created_at")
    .order("enabled", { ascending: false })
    .order("created_at", { ascending: true });

  const recipients: Recipient[] = (data ?? []) as Recipient[];

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Notifications</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Email recipients for room status &amp; listing-action changes.
          Anyone on this list is also re-pinged 24 hours after a change.
        </p>
      </header>

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Add recipient
        </h2>
        <div className="mt-3">
          <AddRecipientForm />
        </div>
      </section>

      <section className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
        <table className="w-full text-sm">
          <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Label</th>
              <th className="px-4 py-2 font-medium">Added</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {recipients.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-sm text-muted"
                >
                  No recipients yet. Add one above to start receiving room-change
                  notifications.
                </td>
              </tr>
            )}
            {recipients.map((r, i) => (
              <tr
                key={r.id}
                className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
              >
                <td className="px-4 py-2.5 text-ink">{r.email}</td>
                <td className="px-4 py-2.5 text-ink">{r.label || "—"}</td>
                <td className="px-4 py-2.5 text-muted">
                  {formatDate(r.created_at)}
                </td>
                <td className="px-4 py-2.5">
                  {r.enabled ? (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-text">
                      Enabled
                    </span>
                  ) : (
                    <span className="rounded-full border border-stone bg-white px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
                      Paused
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <form action={toggleRecipient}>
                      <input type="hidden" name="id" value={r.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(r.enabled)}
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-stone bg-white px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-ink hover:bg-warm"
                      >
                        {r.enabled ? "Pause" : "Resume"}
                      </button>
                    </form>
                    <form action={deleteRecipient}>
                      <input type="hidden" name="id" value={r.id} />
                      <button
                        type="submit"
                        className="rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
