import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import {
  CLEANING_CADENCE_DAYS,
  cleaningScheduleFor,
  todayISO,
  type CleaningStatus,
} from "@/lib/cleaning";
import { AddCleaning, type PropertyOption } from "./add-cleaning";
import { CleaningRow, type CleaningRowData } from "./cleaning-row";

export const dynamic = "force-dynamic";

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
};

type Row = {
  id: string;
  property_id: string;
  cleaning_date: string;
  assigned_to: string | null;
  notes: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};

function propertyLabel(p: {
  building_name: string | null;
  street_address: string;
  unit_number: string;
}) {
  return `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
}

const STATUS_PILL: Record<CleaningStatus, string> = {
  never: "bg-red-100 text-red-900",
  overdue: "bg-red-100 text-red-900",
  due_soon: "bg-orange-100 text-orange-900",
  scheduled: "bg-warm text-ink/70",
};

const STATUS_ORDER: Record<CleaningStatus, number> = {
  never: 0,
  overdue: 1,
  due_soon: 2,
  scheduled: 3,
};

type FilterKey = "overdue" | "due_soon";
function isFilterKey(v: string | undefined): v is FilterKey {
  return v === "overdue" || v === "due_soon";
}

type PageProps = {
  searchParams: Promise<{ filter?: string }>;
};

export default async function CleaningPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const activeFilter = isFilterKey(params.filter) ? params.filter : null;

  const supabase = await createClient();

  const [{ data: cleanings }, { data: properties }] = await Promise.all([
    supabase
      .from("cleaning_records")
      .select(
        `id, property_id, cleaning_date, assigned_to, notes,
         properties(id, building_name, street_address, unit_number)`,
      )
      .order("cleaning_date", { ascending: false })
      .returns<Row[]>(),
    supabase
      .from("properties")
      .select("id, building_name, street_address, unit_number")
      .order("street_address", { ascending: true }),
  ]);

  const propertyOptions: PropertyOption[] = (properties ?? []).map((p) => ({
    id: p.id,
    label: propertyLabel(p),
  }));

  const rows: CleaningRowData[] = (cleanings ?? []).map((c) => {
    const p = one(c.properties);
    return {
      id: c.id,
      property_id: c.property_id,
      property_label: p ? propertyLabel(p) : null,
      cleaning_date: c.cleaning_date,
      assigned_to: c.assigned_to,
      notes: c.notes,
    };
  });

  const today = todayISO();

  // Most-recent *past* cleaning per property — future-dated move-out
  // scheduled rows shouldn't count as "last cleaned".
  const lastByProperty = new Map<string, string>();
  for (const r of rows) {
    if (r.cleaning_date > today) continue;
    if (!lastByProperty.has(r.property_id)) {
      lastByProperty.set(r.property_id, r.cleaning_date);
    }
  }

  const schedule = propertyOptions
    .map((p) => ({
      property: p,
      ...cleaningScheduleFor(lastByProperty.get(p.id) ?? null, today),
    }))
    .sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      // within same status, earlier next-due first
      return (a.nextDue ?? "") < (b.nextDue ?? "") ? -1 : 1;
    });

  const overdueCount = schedule.filter(
    (s) => s.status === "overdue" || s.status === "never",
  ).length;
  const dueSoonCount = schedule.filter((s) => s.status === "due_soon").length;

  const filteredSchedule = !activeFilter
    ? schedule
    : activeFilter === "overdue"
      ? schedule.filter(
          (s) => s.status === "overdue" || s.status === "never",
        )
      : schedule.filter((s) => s.status === "due_soon");

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <h1 className="text-3xl tracking-tight text-ink">
            <span className="font-display text-accent-text">Cleaning</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every unit is cleaned every {CLEANING_CADENCE_DAYS} days. Overdue
            cleans rise to the top.
          </p>
        </div>
        <AddCleaning properties={propertyOptions} />
      </header>

      {propertyOptions.length > 0 && (
        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiCard
            label="Overdue"
            value={overdueCount}
            accent="bg-red-100 text-red-900"
            href={
              activeFilter === "overdue" ? "/cleaning" : "/cleaning?filter=overdue"
            }
            active={activeFilter === "overdue"}
          />
          <KpiCard
            label="Due in ≤ 7 days"
            value={dueSoonCount}
            accent="bg-orange-100 text-orange-900"
            href={
              activeFilter === "due_soon" ? "/cleaning" : "/cleaning?filter=due_soon"
            }
            active={activeFilter === "due_soon"}
          />
          <KpiCard
            label="Total units"
            value={schedule.length}
            accent="bg-warm text-ink/70"
            href="/cleaning"
            active={activeFilter === null}
          />
        </section>
      )}

      {propertyOptions.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-muted">
            Cleaning schedule ({filteredSchedule.length})
          </h2>
          {filteredSchedule.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
              No units match this filter.{" "}
              <Link href="/cleaning" className="text-accent-text">
                Clear filter
              </Link>
              .
            </p>
          ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {filteredSchedule.map((s) => (
              <li
                key={s.property.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-sm shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink">{s.property.label}</p>
                  <p className="text-xs text-muted">
                    Last: {s.last ? formatDate(s.last) : "never"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {s.nextDue && (
                    <span className="text-xs text-muted">
                      Next: {formatDate(s.nextDue)}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_PILL[s.status]}`}
                  >
                    {s.status === "never"
                      ? "Never cleaned"
                      : s.status === "overdue"
                        ? `Overdue ${Math.abs(s.daysUntil ?? 0)}d`
                        : s.status === "due_soon"
                          ? `Due in ${s.daysUntil}d`
                          : `In ${s.daysUntil}d`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          )}
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-wide text-muted">
          All cleanings ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-white px-6 py-10 text-center text-sm text-muted shadow-sm">
            No cleanings logged yet. Click <em>Log cleaning</em> to record one.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((r) => (
              <CleaningRow
                key={r.id}
                record={r}
                properties={propertyOptions}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
  href,
  active,
}: {
  label: string;
  value: number;
  accent: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-2xl p-4 shadow-sm transition ${
        active
          ? "bg-ink text-white ring-2 ring-ink"
          : "bg-white hover:shadow"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p
          className={`text-xs uppercase tracking-wide ${active ? "text-white/70" : "text-muted"}`}
        >
          {label}
        </p>
        {!active && (
          <span className={`h-2 w-2 rounded-full ${accent.split(" ")[0]}`} />
        )}
      </div>
      <p
        className={`mt-2 text-3xl font-light ${active ? "text-white" : "text-ink"}`}
      >
        {value}
      </p>
    </Link>
  );
}
