import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { currentWeek, todayISO, formatDate } from "@/lib/date";
import { getCleanerWeekSchedule, type CleanerCleaning } from "@/lib/cleaner-schedule";
import {
  gatherCleaningContext,
  type CleaningUnitContext,
} from "@/lib/cleaning-context";

export const dynamic = "force-dynamic";
// Token in the URL is the only credential; keep these pages out of search.
export const metadata = {
  title: "Cleaning schedule",
  robots: { index: false, follow: false },
};

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type PageProps = { params: Promise<{ token: string }> };

function ContactRow({ c }: { c: CleaningUnitContext["occupants"][number] }) {
  const phone = c.phone?.replace(/[^\d+]/g, "");
  return (
    <div className="border-b border-stone/40 py-2 last:border-b-0">
      <p className="text-ink">
        {c.full_name}
        {c.room_number ? (
          <span className="text-muted"> · {c.room_number}</span>
        ) : null}
        {c.vacated ? (
          <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-text">
            Vacated
          </span>
        ) : null}
      </p>
      <p className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
        {phone ? (
          <a href={`tel:${phone}`} className="text-accent-text underline">
            {c.phone}
          </a>
        ) : null}
        {c.email ? (
          <a href={`mailto:${c.email}`} className="break-all text-accent-text underline">
            {c.email}
          </a>
        ) : null}
        {!c.phone && !c.email ? (
          <span className="text-muted">No contact on file</span>
        ) : null}
      </p>
    </div>
  );
}

function CleaningCard({
  c,
  ctx,
}: {
  c: CleanerCleaning;
  ctx: CleaningUnitContext | null;
}) {
  return (
    <details className="group rounded-xl bg-white shadow-sm ring-1 ring-stone/30">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-ink">
            {c.unitLabel}
            {c.isMoveOut ? (
              <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-text">
                Move-out{c.roomLabel ? ` · ${c.roomLabel}` : ""}
              </span>
            ) : null}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted">
            {formatDate(c.date)}
          </p>
        </div>
        <span className="shrink-0 text-xs uppercase tracking-wide text-accent-text group-open:hidden">
          Details
        </span>
        <span className="hidden shrink-0 text-xs uppercase tracking-wide text-muted group-open:inline">
          Hide
        </span>
      </summary>
      <div className="border-t border-stone/30 px-4 py-3">
        <p className="text-xs uppercase tracking-wide text-muted">Leaseholder</p>
        <p className="mb-3 text-ink">{ctx?.leaseholderName ?? "—"}</p>
        <p className="text-xs uppercase tracking-wide text-muted">Tenants</p>
        {ctx && ctx.occupants.length > 0 ? (
          <div className="mt-1">
            {ctx.occupants.map((o, i) => (
              <ContactRow key={i} c={o} />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-muted">No tenants on record.</p>
        )}
        {c.notes ? (
          <>
            <p className="mt-3 text-xs uppercase tracking-wide text-muted">Notes</p>
            <p className="text-ink">{c.notes}</p>
          </>
        ) : null}
      </div>
    </details>
  );
}

export default async function CleanerSchedulePage({ params }: PageProps) {
  const { token } = await params;
  const supabase = admin();

  const { data: cleaner } = await supabase
    .from("cleaners")
    .select("id, name")
    .eq("schedule_token", token)
    .maybeSingle<{ id: string; name: string | null }>();
  if (!cleaner) notFound();

  const today = todayISO();
  const { end } = currentWeek();
  const cleanings = await getCleanerWeekSchedule(supabase, cleaner.id, today, end);

  // Gather unit context once per distinct property.
  const propertyIds = Array.from(new Set(cleanings.map((c) => c.propertyId)));
  const ctxEntries = await Promise.all(
    propertyIds.map(
      async (pid) => [pid, await gatherCleaningContext(supabase, pid)] as const,
    ),
  );
  const ctxByProperty = new Map(ctxEntries);

  const firstName = cleaner.name?.split(/\s+/)[0] ?? "there";

  return (
    <main className="min-h-screen bg-cream px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <div className="h-1.5 w-12 rounded-full bg-accent" />
        <h1 className="mt-4 text-3xl tracking-tight text-ink">
          Hi {firstName},
        </h1>
        <p className="mt-1 text-muted">
          Your cleaning schedule for {formatDate(today)} – {formatDate(end)}.
        </p>

        {cleanings.length === 0 ? (
          <p className="mt-8 rounded-xl bg-white px-6 py-12 text-center text-muted shadow-sm">
            No cleanings scheduled for the rest of this week.
          </p>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            {cleanings.map((c) => (
              <CleaningCard
                key={c.id}
                c={c}
                ctx={ctxByProperty.get(c.propertyId) ?? null}
              />
            ))}
          </div>
        )}

        <p className="mt-10 text-center text-xs text-muted">
          Tap a cleaning to see the unit&apos;s tenants and contacts. This page
          always shows your latest schedule.
        </p>
      </div>
    </main>
  );
}
