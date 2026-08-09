"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignDeposit,
  dismissDeposit,
  restoreDeposit,
  ignoreUnmatchedPayer,
} from "./actions";

export type AssignTenantOption = {
  tenancyId: string;
  label: string;
  /** Past tenant — assignable (late payments, prepayments), shown muted. */
  ended?: boolean;
};

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : s;
}

/** One unassigned transaction with inline controls. Assigning posts the money
 *  to the tenant's ledger immediately and records the bank's payer name as
 *  their alias so future statements match automatically. Dismiss tucks the
 *  row into the collapsed Dismissed sub-list (restorable, searchable). */
export function AssignDepositForm({
  depositId,
  payerKey,
  label,
  amount,
  date,
  dismissed,
  ignored,
  tenants,
}: {
  depositId: string;
  payerKey: string;
  label: string;
  amount: number;
  date: string | null;
  dismissed: boolean;
  ignored: boolean;
  tenants: AssignTenantOption[];
}) {
  const [tenancyId, setTenancyId] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedLabel = useMemo(
    () => tenants.find((t) => t.tenancyId === tenancyId)?.label ?? "",
    [tenants, tenancyId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => t.label.toLowerCase().includes(q));
  }, [tenants, query]);

  // Close the dropdown when clicking outside the control.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row visible while arrow-keying through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function pick(t: AssignTenantOption) {
    setTenancyId(t.tenancyId);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[activeIndex]) {
        e.preventDefault();
        pick(filtered[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  function run(action: () => Promise<{ error?: string; success?: string } | undefined>) {
    startTransition(async () => {
      const res = await action();
      if (res?.error) toast.error(res.error);
      else toast.success(res?.success ?? "Done.");
    });
  }

  function assign() {
    if (!tenancyId) {
      toast.error("Pick a tenant to assign this deposit to.");
      return;
    }
    const fd = new FormData();
    fd.set("deposit_id", depositId);
    fd.set("tenancy_id", tenancyId);
    run(() => assignDeposit(undefined, fd));
  }

  function dismiss() {
    const fd = new FormData();
    fd.set("deposit_id", depositId);
    run(() => dismissDeposit(undefined, fd));
  }

  function restore() {
    const fd = new FormData();
    fd.set("deposit_id", depositId);
    run(() => restoreDeposit(undefined, fd));
  }

  function ignore() {
    const fd = new FormData();
    fd.set("payer_key", payerKey);
    run(() => ignoreUnmatchedPayer(undefined, fd));
  }

  const dateLabel = fmtDate(date);
  const inDismissedList = dismissed || ignored;

  return (
    <li
      className={`flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 text-sm ${
        inDismissedList ? "bg-warm/40 opacity-80" : "bg-cream/60"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-ink">{label}</p>
        <p className="text-xs text-muted">
          {dateLabel}
          {ignored && (
            <span className="ml-2 rounded-full bg-warm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Not rent
            </span>
          )}
          {dismissed && !ignored && (
            <span className="ml-2 rounded-full bg-warm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Dismissed
            </span>
          )}
        </p>
      </div>
      <span className="shrink-0 font-medium text-ink tabular-nums">
        {fmtMoney(amount)}
      </span>
      <div ref={boxRef} className="relative w-[14rem] shrink-0">
        <input
          type="text"
          value={open ? query : selectedLabel}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0); // new filter → highlight back to the top row
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          disabled={pending}
          placeholder="Assign to…"
          role="combobox"
          aria-expanded={open}
          aria-controls={`assign-tenant-list-${depositId}`}
          className="w-full rounded-lg border border-stone bg-white px-2 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {tenancyId && !open && (
          <button
            type="button"
            onClick={() => {
              setTenancyId("");
              setQuery("");
            }}
            disabled={pending}
            aria-label="Clear selection"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
          >
            ×
          </button>
        )}
        {open && (
          <ul
            id={`assign-tenant-list-${depositId}`}
            ref={listRef}
            role="listbox"
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-lg border border-stone bg-white py-1 shadow-lg"
          >
            {filtered.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-muted">No matches</li>
            ) : (
              filtered.map((t, i) => (
                <li key={t.tenancyId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    onClick={() => pick(t)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`block w-full truncate px-2 py-1.5 text-left text-sm ${
                      t.ended ? "text-muted" : "text-ink"
                    } ${i === activeIndex ? "bg-cream" : ""} ${
                      t.tenancyId === tenancyId ? "font-medium" : ""
                    }`}
                  >
                    {t.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={assign}
        disabled={pending || !tenancyId}
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Working…" : "Assign"}
      </button>
      {inDismissedList ? (
        dismissed ? (
          <button
            type="button"
            onClick={restore}
            disabled={pending}
            title="Bring this transaction back to the unassigned list"
            className="shrink-0 rounded-full border border-stone bg-white px-3 py-1.5 text-xs font-medium text-muted shadow-sm transition hover:bg-warm hover:text-ink disabled:opacity-50"
          >
            Restore
          </button>
        ) : null
      ) : (
        <>
          <button
            type="button"
            onClick={dismiss}
            disabled={pending}
            title="Dismiss this transaction — it stays here under Dismissed, searchable and restorable"
            className="shrink-0 rounded-full border border-stone bg-white px-3 py-1.5 text-xs font-medium text-muted shadow-sm transition hover:bg-warm hover:text-ink disabled:opacity-50"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={ignore}
            disabled={pending}
            title="Not rent — hide every transaction from this payer (undo from the payer chips below)"
            className="shrink-0 rounded-full border border-stone bg-white px-3 py-1.5 text-xs font-medium text-muted shadow-sm transition hover:bg-warm hover:text-ink disabled:opacity-50"
          >
            Not rent
          </button>
        </>
      )}
    </li>
  );
}
