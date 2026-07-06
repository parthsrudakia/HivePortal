"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { SearchableSelect } from "@/components/searchable-select";
import {
  assignBillProperty,
  deleteBill,
  dismissOverage,
  getStatementUrl,
} from "./actions";
import {
  billMonth,
  filterBills,
  fmtDate,
  fmtMoney,
  isOverThreshold,
  monthLabel,
  usageTotal,
  OVERAGE_THRESHOLD,
  type BillRow,
  type UnitOpt,
} from "./bill-utils";

const TYPE_LABEL: Record<string, string> = {
  electric: "Electric",
  gas: "Gas",
  water: "Water",
  internet: "Internet",
  trash: "Trash",
  other: "Other",
};

export function BillsLog({
  bills,
  units,
  filter,
  setFilter,
  overOnly,
  setOverOnly,
}: {
  bills: BillRow[];
  units: UnitOpt[];
  filter: string;
  setFilter: (f: string) => void;
  overOnly: boolean;
  setOverOnly: (fn: (o: boolean) => boolean) => void;
}) {
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const unitName = useMemo(
    () => new Map(units.map((u) => [u.id, u.label])),
    [units],
  );

  const visible = filterBills(bills, filter, overOnly);

  // Month groups (newest first), each holding unit groups (alphabetical,
  // unmatched last).
  const months = useMemo(() => {
    const byMonth = new Map<string, BillRow[]>();
    for (const b of visible) {
      const m = billMonth(b);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m)!.push(b);
    }
    return [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, rows]) => {
        const byUnit = new Map<string, BillRow[]>();
        for (const b of rows) {
          const key = b.property_id ?? "unmatched";
          if (!byUnit.has(key)) byUnit.set(key, []);
          byUnit.get(key)!.push(b);
        }
        const unitGroups = [...byUnit.entries()]
          .map(([key, groupBills]) => ({
            key,
            label:
              key === "unmatched"
                ? "⚠ Unmatched"
                : unitName.get(key) ?? "Unit",
            bills: groupBills,
            total: groupBills.reduce((s, b) => s + Number(b.total_amount), 0),
          }))
          .sort((a, b) =>
            a.key === "unmatched" ? 1 : b.key === "unmatched" ? -1 : a.label.localeCompare(b.label),
          );
        return {
          month,
          bills: rows,
          unitGroups,
          total: rows.reduce((s, b) => s + Number(b.total_amount), 0),
        };
      });
  }, [visible, unitName]);

  const hasUnmatched = bills.some((b) => !b.property_id);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl tracking-tight text-ink">
          Expense <span className="font-display text-accent-text">log</span>
        </h2>
        <button
          type="button"
          onClick={() => setOverOnly((o) => !o)}
          className={`ml-auto rounded-full border px-3 py-1.5 text-xs font-medium transition ${
            overOnly
              ? "border-red-300 bg-red-50 text-red-700"
              : "border-stone bg-white text-muted hover:text-ink"
          }`}
          title="Show only electric/gas bills whose usage exceeds $200"
        >
          ⚡ Over $200 only
        </button>
        <SearchableSelect
          className="w-64"
          options={units}
          pinned={[
            { id: "", label: "All units" },
            ...(hasUnmatched ? [{ id: "unmatched", label: "⚠ Unmatched" }] : []),
          ]}
          value={filter}
          onSelect={setFilter}
          placeholder="Search units…"
        />
      </div>

      <OverageFlags
        bills={visible}
        unitName={unitName}
      />

      <div className="mt-4 flex flex-col gap-3">
        {months.map(({ month, unitGroups, total: monthTotal }) => {
          const open = openMonths.has(month);
          // No overflow-hidden on the card: it would clip the unit-picker
          // dropdown inside the bill cards. Corners are rounded per-child.
          return (
            <div key={month} className="rounded-2xl bg-white shadow-sm">
              <button
                type="button"
                onClick={() =>
                  setOpenMonths((prev) => {
                    const next = new Set(prev);
                    if (next.has(month)) next.delete(month);
                    else next.add(month);
                    return next;
                  })
                }
                className={`flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-warm/40 ${
                  open ? "rounded-t-2xl" : "rounded-2xl"
                }`}
              >
                <span className="text-muted">{open ? "▾" : "▸"}</span>
                <span className="text-base font-medium text-ink">
                  {monthLabel(month)}
                </span>
                <span className="text-xs text-muted">
                  {unitGroups.length} unit{unitGroups.length === 1 ? "" : "s"}
                </span>
                <span className="ml-auto text-base font-semibold tabular-nums text-ink">
                  {fmtMoney(monthTotal)}
                </span>
              </button>

              {open && (
                <div className="flex flex-col gap-4 rounded-b-2xl border-t border-stone/40 bg-cream/40 px-4 py-4">
                  <MissingUnits
                    units={units.filter(
                      (u) => !unitGroups.some((g) => g.key === u.id),
                    )}
                  />
                  {unitGroups.map((g) => (
                    <div key={g.key}>
                      <div className="flex items-center justify-between px-1 pb-2">
                        <span
                          className={`text-xs font-medium uppercase tracking-wide ${
                            g.key === "unmatched" ? "text-amber-800" : "text-muted"
                          }`}
                        >
                          {g.label}
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-ink/80">
                          {fmtMoney(g.total)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {g.bills.map((b) => (
                          <BillCard key={b.id} bill={b} units={units} unitName={unitName} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {months.length === 0 && (
          <p className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-muted shadow-sm">
            No utility bills logged yet — drop a statement above to start.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Alert banner: electric/gas statements whose usage charges (incl. tax,
 * excl. late fees) exceed the $200 lease threshold — the excess is billable
 * to the unit's occupants.
 */
function OverageFlags({
  bills,
  unitName,
}: {
  bills: BillRow[];
  unitName: Map<string, string>;
}) {
  const [pending, startTransition] = useTransition();
  const flagged = bills
    .filter((b) => isOverThreshold(b) && !b.overage_dismissed)
    .map((b) => ({
      id: b.id,
      unit: b.property_id
        ? unitName.get(b.property_id) ?? "Unit"
        : "⚠ Unmatched unit",
      month: monthLabel(billMonth(b)),
      type: b.utility_type === "electric" ? "Electric" : "Gas",
      usage: usageTotal(b),
    }))
    .sort((a, b) => b.usage - a.usage);
  if (flagged.length === 0) return null;

  const dismiss = (ids: string[]) =>
    startTransition(async () => {
      const r = await dismissOverage(ids, true);
      if (r?.error) toast.error(r.error);
    });

  const openStatement = (id: string) =>
    startTransition(async () => {
      const r = await getStatementUrl(id);
      if (r.error) toast.error(r.error);
      else if (r.url) window.open(r.url, "_blank");
    });

  return (
    <div className="mt-4 rounded-2xl border border-red-200 bg-red-50/80 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-red-900">
          ⚡ Over the $200 utility threshold
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => dismiss(flagged.map((f) => f.id))}
          className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
        >
          Discard all
        </button>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {flagged.map((f) => (
          <li
            key={f.id}
            role="button"
            tabIndex={0}
            title="Open the statement"
            onClick={() => openStatement(f.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openStatement(f.id);
              }
            }}
            className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white px-3 py-2 text-sm shadow-sm transition hover:bg-red-100/50"
          >
            <span className="font-medium text-ink">{f.unit}</span>
            <span className="text-xs text-muted">
              {f.month} · {f.type}
            </span>
            <span className="ml-auto pr-3 tabular-nums text-ink">
              {fmtMoney(f.usage)}
            </span>
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-red-700">
              +{fmtMoney(f.usage - OVERAGE_THRESHOLD)} over
            </span>
            <button
              type="button"
              disabled={pending}
              aria-label={`Discard flag for ${f.unit}`}
              title="Discard this flag (the badge on the bill stays)"
              onClick={(e) => {
                e.stopPropagation();
                dismiss([f.id]);
              }}
              className="rounded-full px-1.5 text-muted transition hover:text-ink disabled:opacity-50"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Units with no statement logged for the month — shown first inside an
 * expanded month as its own collapsible row (collapsed by default).
 */
function MissingUnits({ units }: { units: UnitOpt[] }) {
  const [open, setOpen] = useState(false);
  if (units.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-amber-900 transition hover:bg-amber-100/60"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>
          No statement uploaded for {units.length} unit
          {units.length === 1 ? "" : "s"} this month
        </span>
      </button>
      {open && (
        <ul className="flex flex-wrap gap-1.5 border-t border-amber-200/60 px-4 py-3">
          {units.map((u) => (
            <li
              key={u.id}
              className="rounded-full border border-amber-200 bg-white px-2.5 py-0.5 text-[11px] text-amber-900"
            >
              {u.label}
            </li>
          ))}
        </ul>
      )}
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
        </div>
        <div className="ml-auto flex items-center gap-3">
          {isOverThreshold(bill) && (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-red-700">
              ⚡ {fmtMoney(usageTotal(bill) - OVERAGE_THRESHOLD)} over $200
            </span>
          )}
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
            <SearchableSelect
              className="w-64"
              options={units}
              pinned={[{ id: "", label: "— no unit —" }]}
              value={bill.property_id ?? ""}
              disabled={pending}
              placeholder="Search units…"
              onSelect={(id) =>
                startTransition(async () => {
                  const r = await assignBillProperty(bill.id, id || null);
                  if (r?.error) toast.error(r.error);
                  else
                    toast.success(
                      id
                        ? "Bill reassigned — future statements from this account will match automatically."
                        : "Bill unassigned.",
                    );
                })
              }
            />
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
