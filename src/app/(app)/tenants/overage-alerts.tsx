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

/**
 * Popup shown on the Rent Tracker when a utility-overage split included
 * tenants who had already moved out. Their share was NOT posted to the
 * ledger — the admin settles it manually (e.g. from the deposit) and
 * dismisses the alert.
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
          These tenants owed a share of an over-$200 utility split but had
          already moved out, so nothing was posted to their ledger. Settle
          their share manually (e.g. against the deposit), then dismiss.
        </p>

        <ul className="mt-4 flex flex-col gap-2">
          {visible.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-cream/70 px-3 py-2 text-sm"
            >
              <span className="font-medium text-ink">{a.tenant_name}</span>
              <span className="text-xs text-muted">
                {a.unit_label} · {a.period_label}
              </span>
              <span className="ml-auto font-semibold tabular-nums text-ink">
                {fmtMoney(a.amount)}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => acknowledge([a.id])}
                className="rounded-full px-1.5 text-muted transition hover:text-ink disabled:opacity-50"
                aria-label={`Dismiss alert for ${a.tenant_name}`}
              >
                ✕
              </button>
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
            {pending ? "Dismissing…" : "Dismiss all"}
          </button>
        </div>
      </div>
    </div>
  );
}
