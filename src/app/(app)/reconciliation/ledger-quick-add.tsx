"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { todayISO } from "@/lib/date";
import {
  addCharge,
  recordPayment,
  type ChargeFormState,
  type PaymentFormState,
} from "../tenants/actions";

/**
 * Row-level quick action on the recon run table (mismatch / missing rows):
 * record a payment or add a charge straight onto the tenant's ledger without
 * leaving the run. On success the page refreshes, so the row's Paid/Balance
 * and status re-derive immediately.
 */
export function LedgerQuickAdd({
  tenancyId,
  tenantId,
  tenantName,
  suggestedAmount,
  canCharge,
}: {
  tenancyId: string;
  tenantId: string;
  tenantName: string;
  /** Prefill for the amount field — the row's shortfall. */
  suggestedAmount: number;
  /** Charges are ledger-operator-only; payments anyone can record. */
  canCharge: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"payment" | "charge">("payment");
  const boxRef = useRef<HTMLDivElement>(null);

  const closeAndRefresh = (message: string) => {
    toast.success(message);
    setOpen(false);
    router.refresh();
  };

  const [paymentState, paymentAction, paymentPending] = useActionState<
    PaymentFormState,
    FormData
  >(async (prev, formData) => {
    const result = await recordPayment(tenancyId, tenantId, prev, formData);
    if (result === undefined) closeAndRefresh(`Payment recorded for ${tenantName}.`);
    return result;
  }, undefined);

  const [chargeState, chargeAction, chargePending] = useActionState<
    ChargeFormState,
    FormData
  >(async (prev, formData) => {
    const result = await addCharge(tenancyId, tenantId, prev, formData);
    if (result === undefined) closeAndRefresh(`Charge added for ${tenantName}.`);
    return result;
  }, undefined);

  // Close on outside click.
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

  const pending = paymentPending || chargePending;
  const error = mode === "payment" ? paymentState?.error : chargeState?.error;
  const amountDefault = suggestedAmount > 0 ? suggestedAmount.toFixed(2) : "";

  const inputCls =
    "rounded-lg border border-stone bg-white px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none";
  const labelCls = "text-[11px] uppercase tracking-wide text-muted";

  return (
    <div ref={boxRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Record a payment${canCharge ? " or add a charge" : ""} for ${tenantName}`}
        className="whitespace-nowrap rounded-full border border-stone bg-white px-2.5 py-1 text-xs font-medium text-ink shadow-sm hover:bg-warm"
      >
        + Ledger
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-stone/40">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted">
            {tenantName}
          </p>

          {canCharge && (
            <div className="mt-3 flex gap-1 rounded-full bg-warm/60 p-1 text-xs font-medium">
              <button
                type="button"
                onClick={() => setMode("payment")}
                className={`flex-1 rounded-full px-2 py-1 ${
                  mode === "payment" ? "bg-ink text-white" : "text-ink hover:bg-warm"
                }`}
              >
                Payment
              </button>
              <button
                type="button"
                onClick={() => setMode("charge")}
                className={`flex-1 rounded-full px-2 py-1 ${
                  mode === "charge" ? "bg-ink text-white" : "text-ink hover:bg-warm"
                }`}
              >
                Charge
              </button>
            </div>
          )}

          {mode === "payment" ? (
            <form action={paymentAction} className="mt-3 flex flex-col gap-2.5">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Amount</span>
                  <input
                    type="number"
                    name="amount"
                    min="0.01"
                    step="0.01"
                    required
                    defaultValue={amountDefault}
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Paid on</span>
                  <input
                    type="date"
                    name="paid_on"
                    required
                    defaultValue={todayISO()}
                    className={inputCls}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Type</span>
                <select
                  name="payment_type"
                  defaultValue="rent"
                  className={`${inputCls} select-field`}
                >
                  <option value="rent">Rent</option>
                  <option value="utility">Utility</option>
                  <option value="late_fee">Late fee</option>
                  <option value="security_deposit">Security deposit</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Notes</span>
                <input
                  type="text"
                  name="notes"
                  placeholder="e.g. Zelle outside statement"
                  className={inputCls}
                />
              </label>
              {error && <p className="text-xs text-red-700">{error}</p>}
              <button
                type="submit"
                disabled={pending} aria-busy={pending}
                className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dark disabled:opacity-50"
              >
                {paymentPending ? "Recording…" : "Record payment"}
              </button>
            </form>
          ) : (
            <form action={chargeAction} className="mt-3 flex flex-col gap-2.5">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Amount</span>
                  <input
                    type="number"
                    name="amount"
                    min="0.01"
                    step="0.01"
                    required
                    defaultValue={amountDefault}
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Charged on</span>
                  <input
                    type="date"
                    name="charged_on"
                    defaultValue={todayISO()}
                    className={inputCls}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Kind</span>
                <select
                  name="kind"
                  defaultValue="late_fee"
                  className={`${inputCls} select-field`}
                >
                  <option value="late_fee">Late fee</option>
                  <option value="security_deposit">Security deposit</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Note</span>
                <input
                  type="text"
                  name="note"
                  placeholder="Required for Other"
                  className={inputCls}
                />
              </label>
              {error && <p className="text-xs text-red-700">{error}</p>}
              <button
                type="submit"
                disabled={pending} aria-busy={pending}
                className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dark disabled:opacity-50"
              >
                {chargePending ? "Adding…" : "Add charge"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
