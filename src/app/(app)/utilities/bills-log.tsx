"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { SearchableSelect } from "@/components/searchable-select";
import {
  assignBillProperty,
  chargeAllOverages,
  chargeOverage,
  deleteBill,
  dismissOverage,
  getStatementUrl,
  previewOverage,
  unpostOverage,
  type OverageChargeResult,
  type OveragePreview,
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
  chargedOnly,
  setChargedOnly,
  canCharge,
  billTenants,
}: {
  bills: BillRow[];
  units: UnitOpt[];
  filter: string;
  setFilter: (f: string) => void;
  overOnly: boolean;
  setOverOnly: (fn: (o: boolean) => boolean) => void;
  chargedOnly: boolean;
  setChargedOnly: (fn: (o: boolean) => boolean) => void;
  canCharge: boolean;
  /** Per over-$200 bill: first names of the tenants sharing the overage. */
  billTenants: Record<string, string[]>;
}) {
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  // Bill the user jumped to from the over-$200 banner: its card is scrolled
  // into view, expanded, and briefly highlighted.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const unitName = useMemo(
    () => new Map(units.map((u) => [u.id, u.label])),
    [units],
  );

  const jumpToBill = (bill: BillRow) => {
    setOpenMonths((prev) => new Set(prev).add(billMonth(bill)));
    setJumpTo(bill.id);
  };

  useEffect(() => {
    if (!jumpTo) return;
    // Runs after the month group has rendered open, so the card exists.
    document
      .getElementById(`bill-${jumpTo}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setJumpTo(null), 2500);
    return () => clearTimeout(t);
  }, [jumpTo]);

  const visible = filterBills(bills, filter, overOnly, chargedOnly);

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
        <button
          type="button"
          onClick={() => setChargedOnly((o) => !o)}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
            chargedOnly
              ? "border-green-300 bg-green-50 text-green-700"
              : "border-stone bg-white text-muted hover:text-ink"
          }`}
          title="Show only bills whose overage was posted to tenants' ledgers"
        >
          ✓ Charged to tenants
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
        onJump={jumpToBill}
        showDismissed={overOnly}
        canCharge={canCharge}
        billTenants={billTenants}
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
                          <BillCard
                            key={b.id}
                            bill={b}
                            units={units}
                            unitName={unitName}
                            highlighted={jumpTo === b.id}
                            canCharge={canCharge}
                          />
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
  onJump,
  showDismissed,
  canCharge,
  billTenants,
}: {
  bills: BillRow[];
  unitName: Map<string, string>;
  onJump: (bill: BillRow) => void;
  /** With the over-$200 filter on, discarded flags resurface (restorable). */
  showDismissed: boolean;
  canCharge: boolean;
  /** Per over-$200 bill: first names of the tenants sharing the overage. */
  billTenants: Record<string, string[]>;
}) {
  const [pending, startTransition] = useTransition();
  // Two-step confirm for the banner-level "Charge all" over every flagged bill.
  const [confirmCharge, setConfirmCharge] = useState<string | null>(null);
  // Charge-tenants preview popup for one bill: per-tenant editable shares.
  const [preview, setPreview] = useState<OveragePreview | null>(null);
  // Per-bill outcomes of the last charge run, shown in a popup until closed.
  const [results, setResults] = useState<OverageChargeResult[] | null>(null);
  // Rows ✕'d in this view. Cleared when the over-$200 filter toggles, so
  // switching it on always brings every over-threshold bill back.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [prevShowDismissed, setPrevShowDismissed] = useState(showDismissed);
  if (showDismissed !== prevShowDismissed) {
    setPrevShowDismissed(showDismissed);
    setHidden(new Set());
  }
  const flagged = bills
    .filter(
      (b) =>
        isOverThreshold(b) &&
        !b.overage_charged_at &&
        !hidden.has(b.id) &&
        (showDismissed || !b.overage_dismissed),
    )
    .map((b) => ({
      id: b.id,
      bill: b,
      dismissed: b.overage_dismissed,
      unit: b.property_id
        ? unitName.get(b.property_id) ?? "Unit"
        : "⚠ Unmatched unit",
      period:
        b.period_start || b.period_end
          ? `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}`
          : b.statement_date
            ? `Statement ${fmtDate(b.statement_date)}`
            : null,
      tenants: billTenants[b.id] ?? [],
      usage: usageTotal(b),
    }))
    .sort((a, b) => b.usage - a.usage);
  // Keep rendering while the results popup is open even if charging emptied
  // the banner (charged bills drop out of the flagged list on revalidation).
  if (flagged.length === 0 && !results) return null;

  // ✕ a row: it disappears from the banner immediately and its flag is
  // marked discarded (already-discarded rows shown under the filter just
  // hide). The over-$200 filter resurfaces everything.
  const hideRows = (rows: { id: string; dismissed: boolean }[]) => {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.add(r.id);
      return next;
    });
    const toDismiss = rows.filter((r) => !r.dismissed).map((r) => r.id);
    if (toDismiss.length > 0) {
      startTransition(async () => {
        const r = await dismissOverage(toDismiss, true);
        if (r?.error) toast.error(r.error);
      });
    }
  };

  // "Charge tenants" on one bill: dry-run the split and open the preview
  // popup, where each tenant's share is editable before posting.
  const openPreview = (id: string) =>
    startTransition(async () => {
      const p = await previewOverage(id);
      if (p.error) toast.error(p.error);
      else setPreview(p);
    });

  const chargeAll = (ids: string[]) =>
    startTransition(async () => {
      const rs = await chargeAllOverages(ids);
      setResults(rs);
      setConfirmCharge(null);
    });

  return (
    <>
      {results && (
        <ChargeResults results={results} onClose={() => setResults(null)} />
      )}
      {preview && (
        <ChargePreview
          preview={preview}
          onClose={() => setPreview(null)}
          onCharged={(r) => {
            setPreview(null);
            setResults([r]);
          }}
        />
      )}
      {flagged.length > 0 && (
    <div className="mt-4 rounded-2xl border border-red-200 bg-red-50/80 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-red-900">
          ⚡ Over the $200 utility threshold
        </p>
        <span className="flex items-center gap-2">
          {canCharge && (confirmCharge === "__all__" ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => chargeAll(flagged.map((f) => f.id))}
                className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-white transition hover:bg-accent-dark disabled:opacity-50"
              >
                {pending
                  ? "Charging…"
                  : `Yes, charge ${flagged.length} bill${flagged.length === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                onClick={() => setConfirmCharge(null)}
                className="text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              title="Split every flagged bill's overage among its unit's AC-room tenants and post the charges"
              onClick={() => setConfirmCharge("__all__")}
              className="rounded-full border border-stone bg-white px-3 py-1 text-xs font-medium text-ink transition hover:border-accent hover:text-accent-text disabled:opacity-50"
            >
              Charge all
            </button>
          ))}
          <button
            type="button"
            disabled={pending}
            onClick={() => hideRows(flagged)}
            className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
          >
            Discard all
          </button>
        </span>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone/40 text-left text-[11px] font-medium uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">Unit</th>
              <th className="px-4 py-2.5 font-medium">Period</th>
              <th className="px-4 py-2.5 font-medium">Tenants charged</th>
              <th className="px-4 py-2.5 text-right font-medium">Usage</th>
              <th className="px-4 py-2.5 text-right font-medium">Overage</th>
              {canCharge && (
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              )}
              <th className="w-10 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone/30">
            {flagged.map((f) => (
              <tr
                key={f.id}
                tabIndex={0}
                title="Show this bill in the log"
                onClick={() => onJump(f.bill)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onJump(f.bill);
                  }
                }}
                className="cursor-pointer transition hover:bg-red-50/70"
              >
                <td className="px-4 py-2.5 font-medium text-ink">{f.unit}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                  {f.period ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-ink/80">
                  {f.tenants.length > 0 ? f.tenants.join(", ") : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-ink">
                  {fmtMoney(f.usage)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-red-700">
                    +{fmtMoney(f.usage - OVERAGE_THRESHOLD)}
                  </span>
                </td>
                {canCharge && (
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={pending}
                      title="Preview each tenant's per-day share of the overage, adjust if needed, then post"
                      onClick={(e) => {
                        e.stopPropagation();
                        openPreview(f.id);
                      }}
                      className="rounded-full border border-stone bg-white px-2.5 py-0.5 text-[11px] font-medium text-ink transition hover:border-accent hover:text-accent-text disabled:opacity-50"
                    >
                      Charge tenants
                    </button>
                  </td>
                )}
                <td className="px-2 py-2.5 text-center">
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Discard flag for ${f.unit}`}
                    title="Discard this row (the ⚡ Over $200 only filter brings it back)"
                    onClick={(e) => {
                      e.stopPropagation();
                      hideRows([f]);
                    }}
                    className="rounded-full px-1.5 text-muted transition hover:text-ink disabled:opacity-50"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
      )}
    </>
  );
}

/**
 * Popup previewing one bill's overage split before anything is posted: each
 * tenant with their covered days and dates, and an editable share. "Charge
 * all" posts the (possibly adjusted) shares to the tenants' ledgers.
 */
function ChargePreview({
  preview,
  onClose,
  onCharged,
}: {
  preview: OveragePreview;
  onClose: () => void;
  onCharged: (r: OverageChargeResult) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      preview.tenants.map((t) => [t.tenancyId, t.amount.toFixed(2)]),
    ),
  );

  const shares = preview.tenants.map((t) => ({
    tenancyId: t.tenancyId,
    amount: Number(amounts[t.tenancyId]),
  }));
  const invalid = shares.some(
    (s) => !Number.isFinite(s.amount) || s.amount < 0,
  );
  const total = invalid
    ? null
    : Math.round(shares.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;

  const chargeAll = () =>
    startTransition(async () => {
      const r = await chargeOverage(preview.billId, shares);
      onCharged(r);
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="border-b border-stone/40 px-6 py-4">
          <h2 className="text-lg font-medium text-ink">Charge tenants</h2>
          <p className="mt-0.5 text-sm text-muted">
            {preview.unit} · {preview.period}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Statement {fmtDate(preview.periodStart)} –{" "}
            {fmtDate(preview.periodEnd)} · {fmtMoney(preview.overage)} over the
            $200 threshold, split per day lived
          </p>
        </div>

        <div className="flex flex-col gap-2 overflow-y-auto px-6 py-4">
          {preview.tenants.map((t) => (
            <div
              key={t.tenancyId}
              className="flex items-center gap-3 rounded-xl border border-stone/40 bg-cream/50 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  {t.name}
                  {t.movedOut && (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      moved out · charged &amp; flagged on Rent Tracker
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  Lived {t.days} of {preview.periodDays} day
                  {preview.periodDays === 1 ? "" : "s"} · {fmtDate(t.firstDay)}{" "}
                  – {fmtDate(t.lastDay)}
                </p>
              </div>
              <label className="ml-auto flex items-center gap-1 text-sm text-ink">
                <span className="text-muted">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amounts[t.tenancyId] ?? ""}
                  onChange={(e) =>
                    setAmounts((prev) => ({
                      ...prev,
                      [t.tenancyId]: e.target.value,
                    }))
                  }
                  className="w-20 rounded-lg border border-stone bg-white px-2 py-1 text-right tabular-nums outline-none transition focus:border-accent"
                  aria-label={`${t.name}'s share`}
                />
              </label>
            </div>
          ))}
          {preview.uncovered > 0 && (
            <p className="text-xs text-muted">
              {fmtMoney(preview.uncovered)} falls on vacant days and will not
              be charged.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-stone/40 px-6 py-3">
          <span className="text-xs text-muted">
            {invalid
              ? "Each share must be a non-negative amount."
              : `Total ${fmtMoney(total ?? 0)} of ${fmtMoney(preview.overage)} overage`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || invalid || !total}
            onClick={chargeAll}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Charging…" : "Charge all"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Popup summarizing a charge run, bill by bill: who was charged what, whose
 * share went to a moved-out alert, and which bills were skipped and why.
 * Stays open until dismissed so a "Charge all" over many bills is reviewable
 * at once.
 */
function ChargeResults({
  results,
  onClose,
}: {
  results: OverageChargeResult[];
  onClose: () => void;
}) {
  const totalCharged = results
    .flatMap((r) => [...r.charged, ...r.movedOut])
    .reduce((s, c) => s + c.amount, 0);
  const chargedBills = results.filter((r) => !r.error).length;
  const skipped = results.filter((r) => r.error).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="border-b border-stone/40 px-6 py-4">
          <h2 className="text-lg font-medium text-ink">
            Overage charges ·{" "}
            <span className="font-display italic text-accent-text">results</span>
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {chargedBills > 0 &&
              `${fmtMoney(totalCharged)} posted across ${chargedBills} bill${chargedBills === 1 ? "" : "s"}.`}
            {skipped > 0 && ` ${skipped} bill${skipped === 1 ? "" : "s"} skipped.`}
          </p>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-6 py-4">
          {results.map((r) => (
            <div key={r.billId} className="rounded-xl border border-stone/40 bg-cream/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-ink">{r.unit}</span>
                <span className="text-xs text-muted">{r.period}</span>
                {r.error ? (
                  <span className="ml-auto rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                    Skipped
                  </span>
                ) : (
                  <span className="ml-auto rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">
                    ✓ Charged
                  </span>
                )}
              </div>
              {r.error ? (
                <p className="mt-1.5 text-xs text-red-700">{r.error}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {r.charged.map((c, i) => (
                    <li key={`c${i}`} className="flex items-center gap-2">
                      <span className="text-ink/80">{c.name}</span>
                      <span className="ml-auto tabular-nums text-ink">
                        {fmtMoney(c.amount)}
                      </span>
                    </li>
                  ))}
                  {r.movedOut.map((m, i) => (
                    <li key={`m${i}`} className="flex items-center gap-2">
                      <span className="text-ink/80">{m.name}</span>
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        moved out · flagged on Rent Tracker
                      </span>
                      <span className="ml-auto tabular-nums text-ink">
                        {fmtMoney(m.amount)}
                      </span>
                    </li>
                  ))}
                  {r.uncovered > 0 && (
                    <li className="text-xs text-muted">
                      {fmtMoney(r.uncovered)} fell on vacant days and was not
                      charged.
                    </li>
                  )}
                </ul>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-stone/40 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
          >
            Done
          </button>
        </div>
      </div>
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
  highlighted = false,
  canCharge,
}: {
  bill: BillRow;
  units: UnitOpt[];
  unitName: Map<string, string>;
  highlighted?: boolean;
  canCharge: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingUnpost, setConfirmingUnpost] = useState(false);
  const [pending, startTransition] = useTransition();
  const extras = bill.utility_bill_charges.filter((c) => c.kind !== "current");

  // Jumped to from the over-$200 banner: expand the card so the details are
  // right there. Adjusted during render (not in an effect) per React's
  // "derive state from props" guidance.
  const [wasHighlighted, setWasHighlighted] = useState(highlighted);
  if (highlighted !== wasHighlighted) {
    setWasHighlighted(highlighted);
    if (highlighted) setOpen(true);
  }

  return (
    <div
      id={`bill-${bill.id}`}
      className={`rounded-2xl bg-white p-5 shadow-sm transition-shadow duration-700 ${
        highlighted ? "ring-2 ring-red-400" : "ring-0 ring-transparent"
      }`}
    >
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
          {bill.overage_charged_at && (
            <span
              title="The overage has been posted to the tenants' ledgers"
              className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700"
            >
              ✓ Charged to tenants · {fmtDate(bill.overage_charged_at)}
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
            {bill.overage_charged_at &&
              canCharge &&
              (!confirmingUnpost ? (
                <button
                  type="button"
                  disabled={pending}
                  title="Remove the posted ledger charges and Rent Tracker alerts for this bill"
                  onClick={() => setConfirmingUnpost(true)}
                  className="rounded-full border border-stone bg-white px-3 py-1 font-medium uppercase tracking-wide text-muted hover:text-red-700"
                >
                  Unpost charge
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await unpostOverage(bill.id);
                        if (r?.error) toast.error(r.error);
                        else if (r?.success) toast.success(r.success);
                        setConfirmingUnpost(false);
                      })
                    }
                    className="rounded-full border border-red-200 bg-red-50 px-3 py-1 font-semibold text-red-700 hover:bg-red-100"
                  >
                    {pending ? "Unposting…" : "Yes, unpost"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingUnpost(false)}
                    className="text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </span>
              ))}
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
