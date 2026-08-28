"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatDate } from "@/lib/date";
import { useDeferredParam } from "@/lib/use-url-param";
import { EditableDate } from "./editable-date";

export type ScheduleRow = {
  id: string;
  label: string;
  cleaners: string[];
  last: string | null;
  next: { id: string; date: string } | null;
  following: string | null;
  /** Lowercased search haystack (label + cleaner names). */
  haystack: string;
};

export function ScheduleTable({ rows }: { rows: ScheduleRow[] }) {
  const query = useDeferredParam("q").trim().toLowerCase();

  const filtered = useMemo(
    () => (query ? rows.filter((r) => r.haystack.includes(query)) : rows),
    [rows, query],
  );

  return (
    <section className="mt-4 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-stone/40">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="sticky top-0 z-10 bg-warm text-left text-xs uppercase tracking-wide text-muted shadow-sm md:top-14">
          <tr>
            <th className="rounded-tl-2xl bg-warm px-4 py-2 font-medium">
              Unit
            </th>
            <th className="bg-warm px-4 py-2 font-medium">Cleaner</th>
            <th className="bg-warm px-4 py-2 font-medium">Last cleaned</th>
            <th className="bg-warm px-4 py-2 font-medium">Upcoming Date</th>
            <th className="rounded-tr-2xl bg-warm px-4 py-2 font-medium">
              Next Date
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
  );
}
