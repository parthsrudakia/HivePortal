"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { formatDate } from "@/lib/date";
import { undismissEndedBalance } from "../actions";

export type HistoryRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  email: string | null;
  unit: string;
  room: string;
  start_date: string;
  move_out_date: string | null;
  months: number | null;
  monthly_rent: number;
  total_paid: number;
  dismissed: boolean;
  balance: number;
  /** Lowercased search haystack (name + email + unit + room). */
  haystack: string;
  /** Group key: unit label, or "Unassigned" for tenancies without a room. */
  groupLabel: string;
  propertyId: string | null;
  /** True when the property was retired ("deleted") from the portfolio. */
  archived: boolean;
};

export type HistoryGroup = {
  label: string;
  propertyId: string | null;
  archived: boolean;
  rows: HistoryRow[];
  subBalance: number;
  subPaid: number;
};

// Exact cents: balances are money, never a rounded approximation.
function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatDuration(months: number | null) {
  if (months === null) return "—";
  if (months < 1) return "< 1 mo";
  if (months < 12) return `${months} mo`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m === 0 ? `${y}y` : `${y}y ${m}m`;
}

// Mirrors the Rent Tracker's balance treatment: red amount when owed, honey
// "Credit" badge when in credit, green badge when settled — plus the
// history-only dismissed marker and undo.
function BalanceCell({
  r,
  canUndismiss,
}: {
  r: HistoryRow;
  canUndismiss: boolean;
}) {
  if (r.balance > 0.005) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Link
          href={`/tenants/${r.tenant_id}`}
          title="Open the ledger to resolve"
          className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 hover:bg-red-100"
        >
          owes {fmtMoney(r.balance)}
        </Link>
        {r.dismissed && (
          <span
            className="rounded-full bg-warm px-2 py-0.5 text-xs text-muted"
            title="Dismissed from the Rent Tracker — the debt is still on the ledger."
          >
            dismissed
          </span>
        )}
        {r.dismissed && canUndismiss && (
          <form action={undismissEndedBalance}>
            <input type="hidden" name="tenancy_id" value={r.id} />
            <button
              type="submit"
              title="Put this balance back on the Rent Tracker's moved-out list."
              className="rounded-full bg-white px-2 py-0.5 text-xs text-muted shadow-sm hover:text-ink"
            >
              Undo
            </button>
          </form>
        )}
      </span>
    );
  }
  if (r.balance < -0.005) {
    return (
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-sm uppercase tracking-wide text-accent-text">
        Credit {fmtMoney(-r.balance)}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-sm uppercase tracking-wide text-green-800">
      Settled
    </span>
  );
}

function SubBalance({ n }: { n: number }) {
  if (n > 0.005) return <span className="text-red-700">{fmtMoney(n)}</span>;
  if (n < -0.005) {
    return (
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-sm uppercase tracking-wide text-accent-text">
        Credit {fmtMoney(-n)}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-sm uppercase tracking-wide text-green-800">
      Settled
    </span>
  );
}

/** Past tenants grouped by property — same look and interactions as the Rent
 *  Tracker's TenantGroups: collapsible property groups with subtotals.
 *  Includes retired ("deleted") properties, marked with a badge. */
export function HistoryGroups({
  groups,
  admin = false,
  canUndismiss = false,
  defaultExpanded = false,
}: {
  groups: HistoryGroup[];
  admin?: boolean;
  canUndismiss?: boolean;
  defaultExpanded?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    defaultExpanded ? new Set() : new Set(groups.map((g) => g.label)),
  );

  const collapseAll = () => setCollapsed(new Set(groups.map((g) => g.label)));
  const expandAll = () => setCollapsed(new Set());
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const cols = admin ? 8 : 7;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={collapseAll}
          className="rounded-full border border-stone px-3 py-1 text-sm font-medium text-ink transition hover:bg-warm"
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={expandAll}
          className="rounded-full border border-stone px-3 py-1 text-sm font-medium text-ink transition hover:bg-warm"
        >
          Expand all
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-base">
          <thead className="sticky top-0 z-10 bg-warm text-left text-sm uppercase tracking-wide text-muted shadow-sm md:top-14">
            <tr>
              <th className="rounded-tl-2xl bg-warm px-5 py-3 font-medium">
                Unit/Tenant
              </th>
              <th className="bg-warm px-5 py-3 font-medium">Room</th>
              <th className="bg-warm px-5 py-3 font-medium">Move-in</th>
              <th className="bg-warm px-5 py-3 font-medium">Move-out</th>
              <th className="bg-warm px-5 py-3 font-medium">Stay</th>
              <th className="bg-warm px-5 py-3 text-right font-medium">
                Monthly
              </th>
              {admin && (
                <th className="bg-warm px-5 py-3 text-right font-medium">
                  Total paid
                </th>
              )}
              <th className="rounded-tr-2xl bg-warm px-5 py-3 text-right font-medium">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => {
              const isCollapsed = collapsed.has(g.label);
              return (
                <Fragment key={g.label}>
                  <tr className="border-t border-stone/60 bg-warm/80">
                    <td colSpan={cols - 2} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggle(g.label)}
                          aria-expanded={!isCollapsed}
                          aria-label={
                            isCollapsed
                              ? `Expand ${g.label}`
                              : `Collapse ${g.label}`
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink transition hover:bg-warm"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                            aria-hidden="true"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        <span className="text-xs font-semibold tabular-nums text-muted">
                          {i + 1}.
                        </span>
                        {g.propertyId ? (
                          <Link
                            href={`/properties/${g.propertyId}`}
                            className="text-xs font-semibold uppercase tracking-wide text-ink hover:text-accent-text"
                          >
                            {g.label}
                          </Link>
                        ) : (
                          <span className="text-xs font-semibold uppercase tracking-wide text-ink">
                            {g.label}
                          </span>
                        )}
                        <span className="text-xs text-muted">
                          ({g.rows.length})
                        </span>
                        {g.archived && (
                          <span
                            className="rounded-full bg-ink/80 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-cream"
                            title="This property was deleted from the portfolio; its history stays for the books."
                          >
                            Deleted
                          </span>
                        )}
                        <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-muted">
                          Unit total
                        </span>
                      </div>
                    </td>
                    {admin && (
                      <td className="px-5 py-2 text-right tabular-nums text-sm font-semibold text-ink">
                        {fmtMoney(g.subPaid)}
                      </td>
                    )}
                    <td className="px-5 py-2 text-right tabular-nums text-sm font-semibold">
                      <SubBalance n={g.subBalance} />
                    </td>
                  </tr>

                  {!isCollapsed &&
                    g.rows.map((r) => {
                      const rowTxt =
                        r.balance > 0.005 ? "text-red-700" : "text-ink";
                      return (
                        <tr
                          key={r.id}
                          className="border-t border-stone/30 transition hover:bg-cream/60"
                        >
                          <td className="px-5 py-3">
                            <Link
                              href={`/tenants/${r.tenant_id}`}
                              className={`${rowTxt} hover:text-accent-text`}
                            >
                              {r.tenant_name}
                            </Link>
                            {r.email && (
                              <p className="text-sm text-muted">{r.email}</p>
                            )}
                          </td>
                          <td className="px-5 py-3 text-ink">{r.room}</td>
                          <td className="px-5 py-3 tabular-nums text-ink">
                            {formatDate(r.start_date)}
                          </td>
                          <td className="px-5 py-3 tabular-nums text-ink">
                            {formatDate(r.move_out_date)}
                          </td>
                          <td className="px-5 py-3 text-muted">
                            {formatDuration(r.months)}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-ink">
                            {fmtMoney(r.monthly_rent)}
                          </td>
                          {admin && (
                            <td className="px-5 py-3 text-right tabular-nums text-ink">
                              {fmtMoney(r.total_paid)}
                            </td>
                          )}
                          <td className="px-5 py-3 text-right tabular-nums">
                            <BalanceCell r={r} canUndismiss={canUndismiss} />
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
