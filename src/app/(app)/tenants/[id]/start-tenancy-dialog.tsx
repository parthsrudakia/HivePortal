"use client";

import { useActionState, useMemo, useState } from "react";
import { startNewTenancy, type TenantFormState } from "../actions";
import { RoomCombobox } from "../new/room-combobox";
import type { RoomOption } from "../room-options";
import { proratedMonthRemainder, todayISO } from "@/lib/date";

/**
 * "Start new tenancy" for a tenant with no active/upcoming tenancy — the
 * reactivation path. Fresh terms (room, rent, start date); the old ledger
 * stays closed, nothing is back-billed.
 */
export function StartTenancyDialog({
  tenantId,
  tenantName,
  rooms,
}: {
  tenantId: string;
  tenantName: string;
  rooms: RoomOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<
    TenantFormState,
    FormData
  >(async (prev, formData) => {
    const result = await startNewTenancy(prev, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);
  const [startDate, setStartDate] = useState(todayISO());
  const [rent, setRent] = useState("");

  const proratedHint = useMemo(() => {
    const monthly = Number(rent);
    if (!startDate || startDate.endsWith("-01")) return null;
    if (!Number.isFinite(monthly) || monthly <= 0) return null;
    return proratedMonthRemainder(startDate, monthly);
  }, [startDate, rent]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
      >
        Start new tenancy
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg tracking-tight text-ink">
          Start a new tenancy for{" "}
          <span className="font-display text-accent-text">{tenantName}</span>
        </h3>
        <p className="mt-1 text-xs text-muted">
          Fresh terms — the months in between are never back-billed. Any
          balance or credit left from their previous stay carries forward,
          since each tenant has one running ledger.
        </p>
        <form action={formAction} className="mt-4 flex flex-col gap-3 text-sm">
          <input type="hidden" name="tenant_id" value={tenantId} />
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">
              Room
            </span>
            <RoomCombobox rooms={rooms} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Start date
              </span>
              <input
                type="date"
                name="start_date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Monthly rent
              </span>
              <input
                type="number"
                name="monthly_rent"
                required
                min="1"
                step="0.01"
                value={rent}
                onChange={(e) => setRent(e.target.value)}
                placeholder="0.00"
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                First month (prorated)
              </span>
              <input
                type="number"
                name="first_month_rent"
                min="0"
                step="0.01"
                placeholder={
                  proratedHint !== null ? proratedHint.toFixed(2) : "full month"
                }
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Security deposit
              </span>
              <input
                type="number"
                name="security_deposit"
                min="0"
                step="0.01"
                placeholder="0.00"
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">
                Lease end date (optional)
              </span>
              <input
                type="date"
                name="lease_end_date"
                className="rounded-lg border border-stone bg-white px-3 py-2 text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          {proratedHint !== null && (
            <p className="text-xs text-muted">
              Mid-month start: first month defaults to ${proratedHint.toFixed(2)}{" "}
              unless you enter a different amount.
            </p>
          )}
          {state?.error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {state.error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending} aria-busy={pending}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
            >
              {pending ? "Creating…" : "Create tenancy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
