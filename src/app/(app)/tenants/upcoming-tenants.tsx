import Link from "next/link";
import { formatDate } from "@/lib/date";

export type UpcomingTenantRow = {
  tenancyId: string;
  tenantId: string;
  name: string;
  unitLabel: string | null;
  roomLabel: string | null;
  startDate: string;
  monthlyRent: number;
};

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * "Upcoming move-ins" — tenancies added with a future start date (status
 * 'upcoming'). They don't bill or appear in the tracker groups until the
 * daily cron activates them on the start date; this section keeps them
 * visible (and their profiles reachable) in the meantime. Collapsed by
 * default.
 */
export function UpcomingTenants({ rows }: { rows: UpcomingTenantRow[] }) {
  if (rows.length === 0) return null;

  return (
    <details className="group mt-10">
      <summary className="flex cursor-pointer list-none items-end justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <h2 className="flex items-center gap-2 text-xl tracking-tight text-ink">
          <span className="text-sm text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          Upcoming{" "}
          <span className="font-display text-accent-text">move-ins</span>
        </h2>
        <span className="text-xs text-muted">
          {rows.length} scheduled
        </span>
      </summary>

      <ul className="mt-4 flex flex-col gap-1.5">
        {rows.map((r) => (
          <li
            key={r.tenancyId}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-white px-4 py-3 text-sm shadow-sm"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/tenants/${r.tenantId}`}
                className="text-ink hover:text-accent-text"
              >
                {r.name}
              </Link>
              <p className="text-xs text-muted">
                {[r.unitLabel, r.roomLabel].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            <span className="shrink-0 tabular-nums text-muted">
              {fmtMoney(r.monthlyRent)}/mo
            </span>
            <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-accent-text">
              Moves in {formatDate(r.startDate)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
