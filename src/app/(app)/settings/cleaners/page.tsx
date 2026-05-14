import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/date";
import { AddCleanerForm } from "./add-form";
import { toggleCleaner, deleteCleaner } from "./actions";

export const dynamic = "force-dynamic";

type Cleaner = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  enabled: boolean;
  created_at: string;
  properties_count?: number;
};

export default async function CleanersPage() {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: cleanersData } = await (supabase as any)
    .from("cleaners")
    .select("id, name, email, phone, enabled, created_at")
    .order("enabled", { ascending: false })
    .order("created_at", { ascending: true });

  const cleaners: Cleaner[] = (cleanersData ?? []) as Cleaner[];

  // Count assigned properties per cleaner so the operator can see at a glance
  // who's wired up and who isn't.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: propsData } = await (supabase as any)
    .from("properties")
    .select("cleaner_id")
    .not("cleaner_id", "is", null);
  const countByCleaner = new Map<string, number>();
  for (const p of (propsData ?? []) as Array<{ cleaner_id: string }>) {
    countByCleaner.set(p.cleaner_id, (countByCleaner.get(p.cleaner_id) ?? 0) + 1);
  }
  for (const c of cleaners) {
    c.properties_count = countByCleaner.get(c.id) ?? 0;
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-stone/60 pb-4">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Cleaners</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          People who clean your units. Each property can have one cleaner
          assigned (on the property page). They get emailed when the unit's
          cleaning schedule changes — including move-out cleanings that are
          auto-scheduled the day before a tenant leaves.
        </p>
      </header>

      <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Add cleaner
        </h2>
        <div className="mt-3">
          <AddCleanerForm />
        </div>
      </section>

      <section className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
        <table className="w-full text-sm">
          <thead className="bg-warm/60 text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Phone</th>
              <th className="px-4 py-2 text-right font-medium">Units</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {cleaners.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-muted"
                >
                  No cleaners yet. Add one above, then assign them to a unit
                  from that unit&apos;s page.
                </td>
              </tr>
            )}
            {cleaners.map((c, i) => (
              <tr
                key={c.id}
                className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
              >
                <td className="px-4 py-2.5 text-ink">{c.name}</td>
                <td className="px-4 py-2.5 text-ink">{c.email}</td>
                <td className="px-4 py-2.5 text-muted">{c.phone || "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                  {c.properties_count}
                </td>
                <td className="px-4 py-2.5">
                  {c.enabled ? (
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
                    <form action={toggleCleaner}>
                      <input type="hidden" name="id" value={c.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(c.enabled)}
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-stone bg-white px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-ink hover:bg-warm"
                      >
                        {c.enabled ? "Pause" : "Resume"}
                      </button>
                    </form>
                    <form action={deleteCleaner}>
                      <input type="hidden" name="id" value={c.id} />
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

      <p className="mt-3 text-xs text-muted">
        Added: {formatDate(new Date().toISOString())}
      </p>
    </div>
  );
}
