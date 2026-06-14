"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addCharge, type ChargeFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";
import { todayISO } from "@/lib/date";

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

export function RecordCharge({
  tenancyId,
  tenantId,
}: {
  tenancyId: string;
  tenantId: string;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const today = todayISO();

  const bound = addCharge.bind(null, tenancyId, tenantId) as (
    state: ChargeFormState,
    formData: FormData,
  ) => Promise<ChargeFormState>;
  const [state, action, pending] = useActionState<ChargeFormState, FormData>(
    bound,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Charge added" });

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
        className="rounded-full border border-stone bg-white px-4 py-2 text-sm font-medium text-ink shadow-sm transition hover:bg-warm"
      >
        Add charge
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="mt-3 rounded-2xl bg-cream/60 p-5"
    >
      <p className="text-xs uppercase tracking-wide text-muted">
        Add a charge
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Type *</span>
          <select name="kind" defaultValue="late_fee" className={fieldInput}>
            <option value="late_fee">Late fee</option>
            <option value="broker_fee">Broker fee</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Amount ($) *</span>
          <input
            type="number"
            name="amount"
            min="0"
            step="0.01"
            defaultValue={50}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Charged on</span>
          <input
            type="date"
            name="charged_on"
            defaultValue={today}
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Note</span>
          <input type="text" name="note" className={fieldInput} />
        </label>
      </div>
      {state?.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save charge"}
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
