"use client";

import { useActionState, useEffect, useRef } from "react";
import { recordPayment, type PaymentFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";
import { todayISO } from "@/lib/date";

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

/**
 * The "Record a payment" form card. The open/close toggle lives in
 * {@link LedgerActions}; this renders only when open and closes itself after
 * a successful save (unmounting doubles as the form reset).
 */
export function PaymentForm({
  tenancyId,
  tenantId,
  defaultAmount,
  onClose,
}: {
  tenancyId: string;
  tenantId: string;
  defaultAmount: number;
  onClose: () => void;
}) {
  const today = todayISO();

  const bound = recordPayment.bind(null, tenancyId, tenantId) as (
    state: PaymentFormState,
    formData: FormData,
  ) => Promise<PaymentFormState>;
  const [state, action, pending] = useActionState<PaymentFormState, FormData>(
    bound,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Payment recorded" });

  const submitted = useRef(false);
  useEffect(() => {
    if (pending) {
      submitted.current = true;
      return;
    }
    if (submitted.current && !state?.error) onClose();
    submitted.current = false;
  }, [pending, state, onClose]);

  return (
    <form action={action} className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Record a payment
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Paid on *</span>
          <input
            type="date"
            name="paid_on"
            defaultValue={today}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Amount ($) *</span>
          <input
            type="number"
            name="amount"
            min="0"
            step="0.01"
            defaultValue={defaultAmount}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Type</span>
          <select
            name="payment_type"
            defaultValue="rent"
            className={`${fieldInput} select-field`}
          >
            <option value="rent">Rent</option>
            <option value="security_deposit">Security deposit</option>
            <option value="late_fee">Late fee</option>
            <option value="utility">Utility</option>
            <option value="refund">Refund</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Notes</span>
          <input type="text" name="notes" className={fieldInput} />
        </label>
      </div>
      {state?.error && (
        <p className="mt-3 text-sm text-red-700">{state.error}</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending} aria-busy={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save payment"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
