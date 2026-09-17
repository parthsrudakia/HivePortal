"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addCharge, type ChargeFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";
import { todayISO } from "@/lib/date";

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

/**
 * The "Add a charge" form card. The open/close toggle lives in
 * {@link LedgerActions}; this renders only when open and closes itself after
 * a successful save (unmounting doubles as the form reset).
 */
export function ChargeForm({
  tenancyId,
  tenantId,
  onClose,
}: {
  tenancyId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState("security_deposit");
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
        Add a charge
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Type *</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={`${fieldInput} select-field`}
          >
            <option value="security_deposit">Security deposit</option>
            <option value="late_fee">Late fee</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Amount ($) *</span>
          <input
            type="number"
            name="amount"
            min="0.01"
            step="0.01"
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
            max={today}
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>
            {kind === "other" ? "Description *" : "Note"}
          </span>
          <input
            type="text"
            name="note"
            required={kind === "other"}
            placeholder={
              kind === "other" ? "Describe the charge (required)" : undefined
            }
            className={fieldInput}
          />
        </label>
      </div>
      {state?.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending} aria-busy={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save charge"}
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
