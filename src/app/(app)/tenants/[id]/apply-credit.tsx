"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { applyRentCredit, type CreditFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

export function ApplyCredit({
  tenancyId,
  tenantId,
  availableCredit,
  depositOwed,
  brokerOwed,
  lateFeeOwed,
}: {
  tenancyId: string;
  tenantId: string;
  availableCredit: number;
  depositOwed: number;
  brokerOwed: number;
  lateFeeOwed: number;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const bound = applyRentCredit.bind(null, tenancyId, tenantId) as (
    state: CreditFormState,
    formData: FormData,
  ) => Promise<CreditFormState>;
  const [state, action, pending] = useActionState<CreditFormState, FormData>(
    bound,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Credit applied" });

  useEffect(() => {
    if (state === undefined && open) {
      formRef.current?.reset();
    }
  }, [state, open]);

  const fmt = (n: number) =>
    `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent-text shadow-sm transition hover:bg-accent/20"
      >
        Apply {fmt(availableCredit)} credit
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="mt-3 rounded-2xl bg-accent/5 p-5 ring-1 ring-accent/20"
    >
      <p className="text-xs uppercase tracking-wide text-muted">
        Apply rent credit ({fmt(availableCredit)} available)
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Apply to *</span>
          <select
            name="kind"
            defaultValue="security_deposit"
            className={fieldInput}
          >
            <option value="security_deposit">
              Security deposit{depositOwed > 0 ? ` (${fmt(depositOwed)} owed)` : ""}
            </option>
            <option value="broker_fee">
              Broker fee{brokerOwed > 0 ? ` (${fmt(brokerOwed)} owed)` : ""}
            </option>
            <option value="late_fee">
              Late fee{lateFeeOwed > 0 ? ` (${fmt(lateFeeOwed)} owed)` : ""}
            </option>
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
            max={availableCredit}
            defaultValue={availableCredit}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={fieldLabel}>Note</span>
          <input type="text" name="note" className={fieldInput} />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted">
        Moves the chosen amount out of the rent credit and into that bucket.
        Capped at what the bucket still owes.
      </p>
      {state?.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Applying…" : "Apply credit"}
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
