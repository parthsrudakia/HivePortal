import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDate, todayISO } from "@/lib/date";
import { CLEANING_CADENCE_DAYS } from "@/lib/cleaning";
import { scheduleUrl } from "@/lib/cleaner-schedule";
import { SearchInput } from "@/components/search-input";
import { AddCleanerForm } from "./add-cleaner";
import { toggleCleaner, deleteCleaner } from "./cleaners-actions";
import { EditableDate } from "./editable-date";

export const dynamic = "force-dynamic";

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Row = {
  id: string;
  property_id: string;
  cleaning_date: string;
};

function propertyLabel(p: {
  building_name: string | null;
  street_address: string;
  unit_number: string;
}) {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

type PageProps = {
  searchParams: Promise<{ view?: string; q?: string }>;
};

export default async function CleaningPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const view: "schedule" | "cleaners" =
    params.view === "cleaners" ? "cleaners" : "schedule";
  const query = (params.q ?? "").trim().toLowerCase();

  const supabase = await createClient();

  const [
    { data: cleanings },
    { data: properties },
    { data: cleanersData },
    { data: links },
  ] = await Promise.all([
    supabase
      .from("cleaning_records")
      .select("id, property_id, cleaning_date")
      .order("cleaning_date", { ascending: true })
      .returns<Row[]>(),
    supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number")
      .order("street_address", { ascending: true }),
    supabase
      .from("cleaners")
      .select("id, name, email, phone, enabled, created_at, schedule_token")
      .order("enabled", { ascending: false })
      .order("created_at", { ascending: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("property_cleaners")
      .select("property_id, cleaner_id"),
  ]);

  const today = todayISO();

  // property_id → assigned cleaner name(s)
  const nameById = new Map(
    (cleanersData ?? []).map((c) => [c.id, c.name as string]),
  );
  const cleanersByProperty = new Map<string, string[]>();
  for (const l of (links ?? []) as Array<{
    property_id: string;
    cleaner_id: string;
  }>) {
    const nm = nameById.get(l.cleaner_id);
    if (!nm) continue;
    const arr = cleanersByProperty.get(l.property_id) ?? [];
    arr.push(nm);
    cleanersByProperty.set(l.property_id, arr);
  }

  // Last *past* cleaning + the upcoming (today-or-future) cleanings per unit.
  const lastByProperty = new Map<string, string>();
  const upByProperty = new Map<string, { id: string; date: string }[]>();
  for (const r of cleanings ?? []) {
    if (r.cleaning_date >= today) {
      const arr = upByProperty.get(r.property_id) ?? [];
      arr.push({ id: r.id, date: r.cleaning_date });
      upByProperty.set(r.property_id, arr);
    } else {
      // cleanings are ascending, so the last past seen is the most recent.
      lastByProperty.set(r.property_id, r.cleaning_date);
    }
  }

  const rows = (properties ?? [])
    .map((p) => {
      const ups = upByProperty.get(p.id) ?? [];
      const next = ups[0] ?? null;
      return {
        id: p.id,
        label: propertyLabel(p),
        cleaners: cleanersByProperty.get(p.id) ?? [],
        last: lastByProperty.get(p.id) ?? null,
        next,
        // The cleaning after Next is always +35 (derived, read-only).
        following: next ? addDaysISO(next.date, CLEANING_CADENCE_DAYS) : null,
      };
    })
    .sort((a, b) => {
      // unscheduled first, then soonest upcoming date; alphabetical within ties
      const ad = a.next?.date ?? "0000";
      const bd = b.next?.date ?? "0000";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { numeric: true });
    });

  const filtered = query
    ? rows.filter((r) =>
        `${r.label} ${r.cleaners.join(" ")}`.toLowerCase().includes(query),
      )
    : rows;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone/60 pb-6">
        <h1 className="text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Cleaning</span>
        </h1>
        <div className="inline-flex rounded-full bg-warm/60 p-0.5 text-xs">
          <Link
            href="/cleaning"
            className={`rounded-full px-3 py-1.5 transition ${
              view === "schedule"
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
          >
            Schedule
          </Link>
          <Link
            href="/cleaning?view=cleaners"
            className={`rounded-full px-3 py-1.5 transition ${
              view === "cleaners"
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
          >
            Cleaners
          </Link>
        </div>
      </header>

      {view === "schedule" && (
        <>
          <div className="mt-6 max-w-xs">
            <SearchInput
              placeholder="Search unit or cleaner…"
              ariaLabel="Search cleaning schedule"
            />
          </div>

          <section className="mt-4 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-stone/40 md:overflow-x-visible">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 z-10 bg-warm text-left text-xs uppercase tracking-wide text-muted shadow-sm md:top-14">
                <tr>
                  <th className="rounded-tl-2xl bg-warm px-4 py-2 font-medium">
                    Unit
                  </th>
                  <th className="bg-warm px-4 py-2 font-medium">Cleaner</th>
                  <th className="bg-warm px-4 py-2 font-medium">Last cleaned</th>
                  <th className="bg-warm px-4 py-2 font-medium">Next cleaning</th>
                  <th className="rounded-tr-2xl bg-warm px-4 py-2 font-medium">
                    Following
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={r.id}
                    className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"}`}
                  >
                    <td className="px-4 py-1.5">
                      <Link
                        href={`/properties/${r.id}`}
                        className="text-ink hover:text-accent-text"
                      >
                        {r.label}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 text-muted">
                      {r.cleaners.length ? r.cleaners.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-1.5 tabular-nums text-muted">
                      {r.last ? formatDate(r.last) : "—"}
                    </td>
                    <td className="px-4 py-1.5">
                      <EditableDate
                        propertyId={r.id}
                        recordId={r.next?.id ?? null}
                        date={r.next?.date ?? null}
                        assignedTo={r.cleaners[0] ?? null}
                      />
                    </td>
                    <td className="px-4 py-1.5 tabular-nums text-muted">
                      {r.following ? formatDate(r.following) : "—"}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-center text-sm text-muted"
                    >
                      {query ? "No units match." : "No properties yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {view === "cleaners" && (
        <section className="mt-6">
          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone/40">
            <AddCleanerForm />
          </div>
          <div className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
            <CleanersTable
              cleaners={(cleanersData ?? []).map((c) => ({
                ...c,
                properties_count: (
                  (links ?? []) as Array<{ cleaner_id: string }>
                ).filter((p) => p.cleaner_id === c.id).length,
              }))}
            />
          </div>
        </section>
      )}
    </div>
  );
}

type CleanerRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  enabled: boolean;
  created_at: string;
  schedule_token: string;
  properties_count: number;
};

function CleanersTable({ cleaners }: { cleaners: CleanerRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
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
            <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
              No cleaners yet.
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
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-text">
                  Enabled
                </span>
              ) : (
                <span className="rounded-full border border-stone bg-white px-2 py-0.5 text-xs uppercase tracking-wide text-muted">
                  Paused
                </span>
              )}
            </td>
            <td className="px-4 py-2.5 text-right">
              <div className="flex items-center justify-end gap-2">
                <a
                  href={scheduleUrl(c.schedule_token)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-stone bg-white px-2.5 py-0.5 text-xs uppercase tracking-wide text-ink hover:bg-warm"
                >
                  Schedule ↗
                </a>
                <form action={toggleCleaner}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="enabled" value={String(c.enabled)} />
                  <button
                    type="submit"
                    className="rounded-full border border-stone bg-white px-2.5 py-0.5 text-xs uppercase tracking-wide text-ink hover:bg-warm"
                  >
                    {c.enabled ? "Pause" : "Resume"}
                  </button>
                </form>
                <form action={deleteCleaner}>
                  <input type="hidden" name="id" value={c.id} />
                  <button
                    type="submit"
                    className="rounded-full px-2.5 py-0.5 text-xs uppercase tracking-wide text-red-700 hover:bg-red-50"
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
  );
}
