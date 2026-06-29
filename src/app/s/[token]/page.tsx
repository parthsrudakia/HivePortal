import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { todayISO, addDaysISO } from "@/lib/date";
import { getCleanerWeekSchedule } from "@/lib/cleaner-schedule";
import { gatherCleaningContext } from "@/lib/cleaning-context";
import { CleanerCalendar, type CalCleaning } from "./cleaner-calendar";

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
  // Load a generous window so month/range navigation has data: from the start
  // of two months ago through ~12 months ahead.
  const [y, m] = today.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1 - 2, 1)).toISOString().slice(0, 10);
  const to = addDaysISO(today, 365);

  const cleanings = await getCleanerWeekSchedule(supabase, cleaner.id, from, to);

  // Gather tenant context once per distinct property, then embed on each cleaning
  // so the client calendar can show contacts without further round-trips.
  const propertyIds = Array.from(new Set(cleanings.map((c) => c.propertyId)));
  const ctxEntries = await Promise.all(
    propertyIds.map(
      async (pid) => [pid, await gatherCleaningContext(supabase, pid)] as const,
    ),
  );
  const ctxByProperty = new Map(ctxEntries);

  const items: CalCleaning[] = cleanings.map((c) => {
    const ctx = ctxByProperty.get(c.propertyId) ?? null;
    return {
      id: c.id,
      date: c.date,
      unitLabel: c.unitLabel,
      isMoveOut: c.isMoveOut,
      roomLabel: c.roomLabel,
      notes: c.notes,
      leaseholderName: ctx?.leaseholderName ?? null,
      occupants: ctx?.occupants ?? [],
    };
  });

  return (
    <CleanerCalendar
      cleanerName={cleaner.name}
      today={today}
      cleanings={items}
    />
  );
}
