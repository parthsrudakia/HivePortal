"use client";

import { useMemo, useState } from "react";
import { unignorePayer } from "./actions";
import {
  AssignDepositForm,
  type AssignTenantOption,
} from "./assign-deposit-form";

export type UnassignedRow = {
  id: string;
  payerKey: string;
  label: string;
  amount: number;
  date: string | null;
  dismissed: boolean;
  ignored: boolean;
};

/** The persistent unassigned-transactions section: active rows newest-first,
 *  dismissed / not-rent rows collapsed underneath. One search box covers both
 *  lists, so a dismissed transaction is always findable. */
export function UnassignedSection({
  rows,
  tenants,
  ignoredPayers,
}: {
  rows: UnassignedRow[];
  tenants: AssignTenantOption[];
  ignoredPayers: { payerKey: string; displayName: string }[];
}) {
  const [query, setQuery] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);

  const q = query.trim().toLowerCase();
  const matchesQuery = (r: UnassignedRow) =>
    !q ||
    [r.label, r.payerKey, r.date ?? "", String(r.amount)]
      .join(" ")
      .toLowerCase()
      .includes(q);

  const { active, dismissed } = useMemo(() => {
    const active: UnassignedRow[] = [];
    const dismissed: UnassignedRow[] = [];
    for (const r of rows) {
      if (!matchesQuery(r)) continue;
      if (r.dismissed || r.ignored) dismissed.push(r);
      else active.push(r);
    }
    return { active, dismissed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q]);

  if (rows.length === 0 && ignoredPayers.length === 0) return null;

  return (
    <section id="unassigned" className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Unassigned transactions ({active.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Bank transactions that didn&apos;t match any tenant. Assign one and it
            posts to that tenant&apos;s ledger immediately — and the payer matches
            automatically from then on. Dismiss what doesn&apos;t need action; it
            stays here under Dismissed, searchable and restorable.
          </p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all transactions…"
          aria-label="Search unassigned and dismissed transactions"
          className="w-64 rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {active.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5">
          {active.map((r) => (
            <AssignDepositForm
              key={r.id}
              depositId={r.id}
              payerKey={r.payerKey}
              label={r.label}
              amount={r.amount}
              date={r.date}
              dismissed={false}
              ignored={false}
              tenants={tenants}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-lg bg-cream/60 px-3 py-4 text-center text-sm text-muted">
          {q ? "No unassigned transactions match your search." : "Nothing waiting — every transaction is posted or dismissed."}
        </p>
      )}

      {dismissed.length > 0 && (
        <div className="mt-5 border-t border-stone/40 pt-4">
          <button
            type="button"
            onClick={() => setShowDismissed((v) => !v)}
            aria-expanded={showDismissed || q.length > 0}
            className="text-xs font-medium uppercase tracking-wide text-muted hover:text-ink"
          >
            {showDismissed || q ? "▾" : "▸"} Dismissed ({dismissed.length})
          </button>
          {(showDismissed || q.length > 0) && (
            <ul className="mt-3 flex flex-col gap-1.5">
              {dismissed.map((r) => (
                <AssignDepositForm
                  key={r.id}
                  depositId={r.id}
                  payerKey={r.payerKey}
                  label={r.label}
                  amount={r.amount}
                  date={r.date}
                  dismissed={r.dismissed}
                  ignored={r.ignored}
                  tenants={tenants}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {ignoredPayers.length > 0 && (
        <div className="mt-5 border-t border-stone/40 pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Not-rent payers ({ignoredPayers.length})
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {ignoredPayers.map((p) => (
              <li
                key={p.payerKey}
                className="flex items-center gap-2 rounded-full bg-warm/60 py-1 pl-3 pr-1 text-sm text-ink"
              >
                {p.displayName}
                <form action={unignorePayer}>
                  <input type="hidden" name="payer_key" value={p.payerKey} />
                  <button
                    type="submit"
                    title="Un-ignore — this payer's transactions return to the unassigned list"
                    className="rounded-full bg-white px-2 py-0.5 text-xs text-muted shadow-sm hover:text-ink"
                  >
                    Undo
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
