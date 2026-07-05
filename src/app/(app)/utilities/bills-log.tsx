"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { assignBillProperty, deleteBill, getStatementUrl } from "./actions";

export type UnitOpt = { id: string; label: string };

export type BillRow = {
  id: string;
  property_id: string | null;
  provider: string | null;
  utility_type: string;
  account_number: string | null;
  service_address: string | null;
  statement_date: string | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  total_amount: number;
  notes: string | null;
  created_at: string;
  utility_bill_charges: {
    id: string;
    kind: "current" | "late_fee" | "other";
    description: string | null;
    amount: number;
  }[];
};

const TYPE_LABEL: Record<string, string> = {
  electric: "Electric",
  gas: "Gas",
  water: "Water",
  internet: "Internet",
  trash: "Trash",
  other: "Other",
};

const fmtMoney = (n: number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

export function BillsLog({ bills, units }: { bills: BillRow[]; units: UnitOpt[] }) {
  const [filter, setFilter] = useState("");
  const unitName = useMemo(
    () => new Map(units.map((u) => [u.id, u.label])),
    [units],
  );

  const visible = filter
    ? bills.filter((b) =>
        filter === "unmatched" ? !b.property_id : b.property_id === filter,
      )
    : bills;

  const total = visible.reduce((s, b) => s + Number(b.total_amount), 0);
  const hasUnmatched = bills.some((b) => !b.property_id);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl tracking-tight text-ink">
          Expense <span className="font-display text-accent-text">log</span>
        </h2>
        <span className="text-sm tabular-nums text-muted">
          {visible.length} bill{visible.length === 1 ? "" : "s"} · {fmtMoney(total)}
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
        >
          <option value="">All units</option>
          {hasUnmatched && <option value="unmatched">⚠ Unmatched</option>}
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {visible.map((b) => (
          <BillCard key={b.id} bill={b} units={units} unitName={unitName} />
        ))}
        {visible.length === 0 && (
          <p className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-muted shadow-sm">
            No utility bills logged yet — drop a statement above to start.
          </p>
        )}
      </div>
    </div>
  );
}

function BillCard({
  bill,
  units,
  unitName,
}: {
  bill: BillRow;
  units: UnitOpt[];
  unitName: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const extras = bill.utility_bill_charges.filter((c) => c.kind !== "current");

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <div
        className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {bill.property_id ? (
              unitName.get(bill.property_id) ?? "Unit"
            ) : (
              <span className="text-amber-800">⚠ Unmatched unit</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {[TYPE_LABEL[bill.utility_type] ?? bill.utility_type, bill.provider]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="text-xs text-muted">
          <p>
            {bill.period_start || bill.period_end
              ? `${fmtDate(bill.period_start)} – ${fmtDate(bill.period_end)}`
              : `Statement ${fmtDate(bill.statement_date)}`}
          </p>
          {bill.due_date && <p>Due {fmtDate(bill.due_date)}</p>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {extras.length > 0 && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              +{extras.length} fee{extras.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-base font-semibold tabular-nums text-ink">
            {fmtMoney(bill.total_amount)}
          </span>
          <span className="text-muted">{open ? "▾" : "▸"}</span>
        </div>
      </div>

      {open && (
        <div className="mt-4 border-t border-stone/40 pt-4">
          <table className="w-full text-sm">
            <tbody>
              {bill.utility_bill_charges.map((c) => (
                <tr key={c.id}>
                  <td className="py-1 pr-3">
                    <span
                      className={`mr-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        c.kind === "current"
                          ? "border-stone bg-warm/60 text-ink/70"
                          : c.kind === "late_fee"
                            ? "border-red-200 bg-red-50 text-red-700"
                            : "border-amber-200 bg-amber-50 text-amber-800"
                      }`}
                    >
                      {c.kind === "current" ? "usage" : c.kind.replace("_", " ")}
                    </span>
                    <span className="text-ink/80">{c.description ?? "—"}</span>
                  </td>
                  <td className="py-1 text-right tabular-nums text-ink">
                    {fmtMoney(c.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {(bill.service_address || bill.account_number || bill.notes) && (
            <p className="mt-3 text-xs text-muted">
              {[
                bill.service_address,
                bill.account_number ? `Acct ${bill.account_number}` : null,
                bill.notes,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <select
              value={bill.property_id ?? ""}
              disabled={pending}
              onChange={(e) =>
                startTransition(async () => {
                  const r = await assignBillProperty(
                    bill.id,
                    e.target.value || null,
                  );
                  if (r?.error) toast.error(r.error);
                  else toast.success("Bill reassigned.");
                })
              }
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg border border-stone bg-white px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
            >
              <option value="">— no unit —</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await getStatementUrl(bill.id);
                  if (r.error) toast.error(r.error);
                  else if (r.url) window.open(r.url, "_blank");
                })
              }
              className="rounded-full border border-stone bg-white px-3 py-1 font-medium uppercase tracking-wide text-muted hover:text-accent-text"
            >
              View statement
            </button>
            {!confirming ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-full border border-stone bg-white px-3 py-1 font-medium uppercase tracking-wide text-muted hover:text-red-700"
              >
                Delete
              </button>
            ) : (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await deleteBill(bill.id);
                      if (r?.error) toast.error(r.error);
                      else toast.success("Bill deleted.");
                    })
                  }
                  className="rounded-full border border-red-200 bg-red-50 px-3 py-1 font-semibold text-red-700 hover:bg-red-100"
                >
                  {pending ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
