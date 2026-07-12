"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTenancyRentAmount } from "../actions";

/**
 * Inline editor for a tenancy's dollar amounts (monthly / prorated / deposit).
 *
 * Monthly rent is special: changing it is a lease renewal, so the editor asks
 * for the new lease's start and end dates alongside the amount. The new rent
 * takes effect from the lease-start month; rent already posted for past
 * months stays exactly as billed.
 */
export function RentAmountEdit({
  field,
  tenancyId,
  tenantId,
  value,
}: {
  field: "monthly_rent" | "first_month_rent" | "security_deposit";
  tenancyId: string;
  tenantId: string;
  value: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  // Renewal fields (monthly rent only).
  const [leaseStart, setLeaseStart] = useState("");
  const [leaseEnd, setLeaseEnd] = useState("");
  // Once the operator edits the end date by hand it stops following the
  // start date's one-year convenience default.
  const [endEdited, setEndEdited] = useState(false);
  const [amount, setAmount] = useState("");
  // Monthly rent is required; the prorated amount and deposit may be
  // cleared (no proration / no deposit on file).
  const clearable = field !== "monthly_rent";

  // A one-year lease from `start`, ending the day before the anniversary.
  const yearFrom = (start: string) => {
    const d = new Date(`${start}T12:00:00`);
    d.setFullYear(d.getFullYear() + 1);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  const open = () => {
    setAmount(value !== null ? String(value) : "");
    // Start both pickers at the current month: renewal from the 1st of this
    // month, ending a year later — editable, just a starting point.
    const now = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    setLeaseStart(start);
    setLeaseEnd(yearFrom(start));
    setEndEdited(false);
    setEditing(true);
  };

  function commit(next: string, newLease?: { start: string; end: string }) {
    const raw = next.trim();
    if (!clearable && raw === "") {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const r = await setTenancyRentAmount(
        tenancyId,
        tenantId,
        field,
        raw === "" ? null : raw,
        newLease,
      );
      if (r && "error" in r) {
        toast.error(r.error);
        return; // keep the editor open so the input isn't lost
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing && field === "monthly_rent") {
    // A rent change is a lease renewal: new amount + new lease start/end.
    // The new rent starts billing from the lease-start month.
    const startPicked = /^\d{4}-\d{2}-\d{2}$/.test(leaseStart);
    return (
      <div className="flex w-fit flex-col gap-2 rounded-xl border border-accent bg-white p-3 shadow-sm">
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          New monthly rent
          <span className="flex items-center gap-1 text-sm text-ink">
            $
            <input
              type="number"
              min="0"
              step="1"
              autoFocus
              value={amount}
              disabled={pending}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 rounded-lg border border-stone bg-white px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </span>
        </label>
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          New lease start
          <input
            type="date"
            value={leaseStart}
            disabled={pending}
            onChange={(e) => {
              const start = e.target.value;
              setLeaseStart(start);
              // Keep the one-year convenience default in step with the start
              // date until the operator sets an end date themselves.
              if (!endEdited && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
                setLeaseEnd(yearFrom(start));
              }
            }}
            className="rounded-lg border border-stone bg-white px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          New lease end
          <input
            type="date"
            value={leaseEnd}
            min={startPicked ? leaseStart : undefined}
            disabled={pending}
            onChange={(e) => {
              setLeaseEnd(e.target.value);
              setEndEdited(true);
            }}
            className="rounded-lg border border-stone bg-white px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <p className="max-w-56 text-[11px] leading-snug text-muted">
          The new rent bills from the lease-start month onward — including
          already-billed months when the lease started in the past. Months
          before the lease start keep the current rate.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !amount || !leaseStart || !leaseEnd}
            onClick={() => commit(amount, { start: leaseStart, end: leaseEnd })}
            className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-white transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <input
        type="number"
        min="0"
        step="1"
        autoFocus
        defaultValue={value ?? ""}
        disabled={pending}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="w-28 rounded-lg border border-accent bg-white px-2 py-1 text-sm text-ink focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className={`-mx-1.5 -my-0.5 rounded px-1.5 py-0.5 text-left text-ink hover:bg-warm/60 focus:outline-none focus:ring-1 focus:ring-accent ${
        pending ? "opacity-60" : ""
      }`}
    >
      {value !== null ? (
        `$${Number(value).toLocaleString()}`
      ) : (
        <span className="text-accent-text">+ Set amount</span>
      )}
    </button>
  );
}
