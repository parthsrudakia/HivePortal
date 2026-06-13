"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { formatDate } from "@/lib/date";

export type DisplayRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_email: string | null;
  end_date: string | null;
  room_number: string | null;
  due: number;
  paid: number;
  balance: number;
};

export type DisplayGroup = {
  label: string;
  propertyId: string | null;
  rows: DisplayRow[];
  subDue: number;
  subPaid: number;
  subBalance: number;
};

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function TenantGroups({ groups }: { groups: DisplayGroup[] }) {
  // Track collapsed groups by label; empty = everything expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const collapseAll = () => setCollapsed(new Set(groups.map((g) => g.label)));
  const expandAll = () => setCollapsed(new Set());
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

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

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <table className="w-full text-base">
          <thead className="bg-warm/60 text-left text-sm uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Tenant</th>
              <th className="px-5 py-3 font-medium">Room</th>
              <th className="px-5 py-3 text-right font-medium">Due</th>
              <th className="px-5 py-3 text-right font-medium">Paid</th>
              <th className="px-5 py-3 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.label);
              const matched =
                g.subDue > 0 && Math.abs(g.subDue - g.subPaid) < 0.005;
              const balCls = matched
                ? "text-green-700"
                : g.subDue > 0
                  ? "text-red-700"
                  : "text-muted";
              return (
                <Fragment key={g.label}>
                  <tr className="border-t border-stone/40 bg-warm/40">
                    <td colSpan={2} className="px-3 py-2">
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
                      </div>
                    </td>
                    <td
                      className={`px-5 py-2 text-right tabular-nums text-sm font-medium ${balCls}`}
                    >
                      {fmtMoney(g.subDue)}
                    </td>
                    <td
                      className={`px-5 py-2 text-right tabular-nums text-sm font-medium ${balCls}`}
                    >
                      {fmtMoney(g.subPaid)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-sm font-medium">
                      {g.subBalance <= 0 && g.subDue > 0 ? (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-sm uppercase tracking-wide text-accent-text">
                          Paid
                        </span>
                      ) : (
                        <span className={balCls}>{fmtMoney(g.subBalance)}</span>
                      )}
                    </td>
                  </tr>

                  {!isCollapsed &&
                    g.rows.map((r) => {
                      const isPaid = r.balance <= 0;
                      const mismatched =
                        r.due > 0 && Math.abs(r.due - r.paid) >= 0.005;
                      const rowTxt = mismatched ? "text-red-700" : "text-ink";
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
                            {r.tenant_email && (
                              <p className="text-sm text-muted">
                                {r.tenant_email}
                              </p>
                            )}
                            {r.end_date && (
                              <p className="mt-1 text-sm text-accent-text">
                                Ending {formatDate(r.end_date)}
                              </p>
                            )}
                          </td>
                          <td className="px-5 py-3 text-ink">
                            {r.room_number ?? "—"}
                          </td>
                          <td
                            className={`px-5 py-3 text-right tabular-nums ${rowTxt}`}
                          >
                            {fmtMoney(r.due)}
                          </td>
                          <td className={`px-5 py-3 text-right ${rowTxt}`}>
                            {fmtMoney(r.paid)}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <span
                              className={
                                isPaid
                                  ? "rounded-full bg-accent/15 px-2 py-0.5 text-sm uppercase tracking-wide text-accent-text"
                                  : rowTxt
                              }
                            >
                              {isPaid ? "Paid" : fmtMoney(r.balance)}
                            </span>
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
