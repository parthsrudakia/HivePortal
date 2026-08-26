import Link from "next/link";
import { formatDate } from "@/lib/date";

export type UpcomingMoveOutRow = {
  tenancyId: string;
  tenantId: string;
  name: string;
  unitLabel: string | null;
  roomLabel: string | null;
  moveOutDate: string;
  monthlyRent: number;
};

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * "Upcoming move-outs" — still-active tenancies with a scheduled move-out
 * date of today or later. The daily cron only ends a tenancy once the date
 * has passed, so these tenants remain in the tracker; this section surfaces
 * who is leaving soon. (Distinct from "Moved out with balance", which lists
 * already-departed tenants who still owe.) Collapsed by default.
 */
export function UpcomingMoveOuts({ rows }: { rows: UpcomingMoveOutRow[] }) {
  if (rows.length === 0) return null;

  return (
    <details className="group mt-10">
      <summary className="flex cursor-pointer list-none items-end justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <h2 className="flex items-center gap-2 text-xl tracking-tight text-ink">
          <span className="text-sm text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          Upcoming{" "}
          <span className="font-display text-accent-text">move-outs</span>
        </h2>
        <span className="text-xs text-muted">{rows.length} scheduled</span>
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
            <span className="shrink-0 rounded-full bg-warm px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-ink/70">
              Moves out {formatDate(r.moveOutDate)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
