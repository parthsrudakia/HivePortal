"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { resolveReversal } from "../actions";

export type ReversalAlert = {
  id: string;
  raw: string;
  amount: number;
  date: string | null;
  /** Suspected original payment, when one matched by payer + amount. */
  suspect: { tenantName: string; paidOn: string } | null;
};

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string | null) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : s;
}

/**
 * Red alert card: negative Zelle rows found in this run's statements —
 * money the bank clawed back after a deposit. "Record reversal" debits the
 * suspect payment's tenant with an offsetting refund; "Dismiss" closes the
 * alert without touching any ledger.
 */
export function ReversalAlerts({ alerts }: { alerts: ReversalAlert[] }) {
  const [pending, startTransition] = useTransition();

  const resolve = (id: string, mode: "refund" | "dismiss") => {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("mode", mode);
    startTransition(async () => {
      const res = await resolveReversal(undefined, fd);
      if (res?.error) toast.error(res.error);
      else toast.success(res?.success ?? "Resolved.");
    });
  };

  if (alerts.length === 0) return null;

  return (
    <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-2 ring-red-200">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">
        Possible reversals ({alerts.length})
      </h2>
      <p className="mt-1 text-xs text-muted">
        Negative Zelle rows in this run&apos;s statements — the bank took this
        money back after it was deposited. Record the reversal to debit the
        tenant&apos;s ledger, or dismiss if it wasn&apos;t rent.
      </p>
      <ul className="mt-4 flex flex-col gap-1.5">
        {alerts.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-ink">{a.raw}</p>
              <p className="text-xs text-muted">
                {fmtDate(a.date) ?? "no date"}
                {a.suspect
                  ? ` · likely reverses ${a.suspect.tenantName}'s payment of ${fmtDate(a.suspect.paidOn)}`
                  : " · no matching posted payment found"}
              </p>
            </div>
            <span className="shrink-0 font-medium tabular-nums text-red-700">
              −{fmtMoney(a.amount)}
            </span>
            {a.suspect && (
              <button
                type="button"
                disabled={pending}
                onClick={() => resolve(a.id, "refund")}
                className="shrink-0 rounded-full bg-red-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-red-800 disabled:opacity-50"
              >
                Record reversal
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => resolve(a.id, "dismiss")}
              className="shrink-0 rounded-full border border-stone bg-white px-3 py-1.5 text-xs font-medium text-muted shadow-sm transition hover:bg-warm hover:text-ink disabled:opacity-50"
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
