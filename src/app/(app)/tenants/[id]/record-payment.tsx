"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { recordPayment, type PaymentFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

export function RecordPayment({
  tenancyId,
  tenantId,
  defaultAmount,
}: {
  tenancyId: string;
  tenantId: string;
  defaultAmount: number;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const today = new Date().toISOString().slice(0, 10);

  const bound = recordPayment.bind(null, tenancyId, tenantId) as (
    state: PaymentFormState,
    formData: FormData,
  ) => Promise<PaymentFormState>;
  const [state, action, pending] = useActionState<PaymentFormState, FormData>(
    bound,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Payment recorded" });

  useEffect(() => {
    if (state === undefined && open) {
      formRef.current?.reset();
    }
  }, [state, open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
      >
        Record payment
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="rounded-2xl bg-white p-5 shadow-sm"
    >
      <p className="text-xs uppercase tracking-wide text-muted">
        Record a payment
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
            className={fieldInput}
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
          <span className={fieldLabel}>Method</span>
          <input
            type="text"
            name="method"
            placeholder="Zelle, ClickPay, Bilt, check…"
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
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
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save payment"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
