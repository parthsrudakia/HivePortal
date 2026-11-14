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
  /** Past move-outs only: what has happened to the room since. */
  roomStatus?: RoomStatus;
  /** Past move-outs only: deposit to give back (deposit charged ± balance). */
  refund?: {
    deposit: number;
    balance: number;
    toReturn: number;
    /** False when the ledger has no deposit charge — needs a manual check. */
    hasDepositCharge: boolean;
  };
};

export type RoomStatus =
  | { kind: "inventory" }
  | { kind: "pending" }
  | {
      kind: "new" | "transfer";
      tenantId: string;
      name: string;
      startDate: string;
      upcoming: boolean;
    };

function RoomStatusLine({ status }: { status: RoomStatus }) {
  if (status.kind === "inventory") {
    return (
      <Link href="/inventory" className="text-accent-text hover:underline">
        In inventory
      </Link>
    );
  }
  if (status.kind === "pending") {
    return (
      <Link href="/tenants/new" className="text-accent-text hover:underline">
        Waiting for tenant info on Add tenant
      </Link>
    );
  }
  const label = status.kind === "transfer" ? "Transferred tenant" : "New tenant";
  return (
    <span className="text-ink/80">
      {label}:{" "}
      <Link
        href={`/tenants/${status.tenantId}`}
        className="text-ink hover:text-accent-text"
      >
        {status.name}
      </Link>
      {status.upcoming && (
        <span className="text-muted">
          {" "}
          · moves in {formatDate(status.startDate)}
        </span>
      )}
    </span>
  );
}

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** "To return $1,300" with the deposit / balance it comes from. */
function RefundCell({
  refund,
  tenantId,
}: {
  refund: NonNullable<UpcomingMoveOutRow["refund"]>;
  tenantId: string;
}) {
  const { deposit, balance, toReturn, hasDepositCharge } = refund;
  const headline =
    toReturn > 0.005 ? (
      <span className="font-medium text-green-700">To return {fmtMoney(toReturn)}</span>
    ) : toReturn < -0.005 ? (
      <span className="font-medium text-red-700">Owes {fmtMoney(-toReturn)}</span>
    ) : (
      <span className="text-muted">Nothing to return</span>
    );
  const balancePart =
    balance > 0.005
      ? `− ${fmtMoney(balance)} owed`
      : balance < -0.005
        ? `+ ${fmtMoney(-balance)} credit`
        : "no balance";
  return (
    <span className="flex shrink-0 flex-col items-end text-right tabular-nums">
      {headline}
      <span className="text-xs text-muted">
        Deposit {fmtMoney(deposit)} {balancePart}
      </span>
      {!hasDepositCharge && (
        <Link
          href={`/tenants/${tenantId}`}
          className="mt-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:underline"
        >
          ⚠ No deposit charge in ledger — check the full ledger
        </Link>
      )}
    </span>
  );
}

/**
 * "Upcoming move-outs" — still-active tenancies with a scheduled move-out
 * date of today or later. The daily cron only ends a tenancy once the date
 * has passed, so these tenants remain in the tracker; this section surfaces
 * who is leaving soon. (Distinct from "Moved out with balance", which lists
 * already-departed tenants who still owe.) Collapsed by default.
 *
 * With `past`, the same list renders as "Past move-outs" — tenants whose
 * move-out fell in the last 30 days, regardless of balance.
 */
export function UpcomingMoveOuts({
  rows,
  past = false,
}: {
  rows: UpcomingMoveOutRow[];
  past?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <details className="group mt-10">
      <summary className="flex cursor-pointer list-none items-end justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <h2 className="flex items-center gap-2 text-xl tracking-tight text-ink">
          <span className="text-sm text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          {past ? "Past" : "Upcoming"}{" "}
          <span className="font-display text-accent-text">move-outs</span>
        </h2>
        <span className="text-xs text-muted">
          {rows.length} {past ? "in the last 30 days" : "scheduled"}
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
              {r.roomStatus && (
                <p className="mt-1 text-xs">
                  <RoomStatusLine status={r.roomStatus} />
                </p>
              )}
            </div>
            {past && r.refund ? (
              <RefundCell refund={r.refund} tenantId={r.tenantId} />
            ) : (
              <span className="shrink-0 tabular-nums text-muted">
                {fmtMoney(r.monthlyRent)}/mo
              </span>
            )}
            <span className="shrink-0 rounded-full bg-warm px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-ink/70">
              {past ? "Moved out" : "Moves out"} {formatDate(r.moveOutDate)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
