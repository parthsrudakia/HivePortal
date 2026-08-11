"use client";

import { useState, useTransition } from "react";
import { acknowledgeOverageAlerts } from "./actions";

export type OverageAlert = {
  id: string;
  tenant_name: string;
  unit_label: string;
  amount: number;
  period_label: string;
};

const fmtMoney = (n: number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// One card per tenant: a tenant charged on several bills (e.g. June and July
// statements of the same unit) shows one card with a line per bill, so the
// list never reads as duplicate rows.
function groupByTenant(alerts: OverageAlert[]) {
  const groups = new Map<string, OverageAlert[]>();
  for (const a of alerts) {
    const key = `${a.tenant_name}|${a.unit_label}`;
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    rows,
    total: rows.reduce((s, r) => s + Number(r.amount), 0),
  }));
}


/**
 * Popup shown on the Rent Tracker when a utility-overage split included
 * tenants who had already moved out. Their share IS posted to their (ended)
 * tenancy's ledger like everyone else's — this alert exists because moved-out
 * tenants don't surface in the normal rent flows, so the admin collects the
 * balance (e.g. against the deposit) and dismisses the alert.
 */
export function OverageAlertsPopup({ alerts }: { alerts: OverageAlert[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const acknowledge = (ids: string[]) =>
    startTransition(async () => {
      await acknowledgeOverageAlerts(ids);
      setDismissed((prev) => new Set([...prev, ...ids]));
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-medium text-ink">
          Utility overcharge ·{" "}
          <span className="font-display italic text-accent-text">
            moved-out tenants
          </span>
        </h2>
        <p className="mt-1 text-sm text-muted">
          These tenants were charged their share of an over-$200 utility
          split but have already moved out, so they won&apos;t see it through
          the usual rent flow. Collect the balance (e.g. against the
          deposit), then dismiss.
        </p>

        <ul className="mt-4 flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
          {groupByTenant(visible).map(({ key, rows, total }) => (
            <li key={key} className="rounded-xl bg-cream/70 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {rows[0].tenant_name}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {rows[0].unit_label}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                  {fmtMoney(total)}
                </span>
              </div>
              {rows.length === 1 ? (
                <p className="mt-1 truncate text-xs text-muted">
                  {rows[0].period_label}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5 border-t border-stone/40 pt-2">
                  {rows.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0 truncate text-xs text-muted">
                        {a.period_label}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-ink">
                        {fmtMoney(a.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={pending}
            onClick={() => acknowledge(visible.map((a) => a.id))}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      </div>
    </div>
  );
}
