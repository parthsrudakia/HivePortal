"use client";

import { useActionState, useRef } from "react";
import { addMonthlyCompanyCost, type LineItemFormState } from "./actions";

/** One-row form to add a company-wide cost for a month (e.g. Upwork). */
export function CompanyCostForm({ defaultMonth }: { defaultMonth: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<LineItemFormState, FormData>(
    async (prev, formData) => {
      const result = await addMonthlyCompanyCost(prev, formData);
      if (result === undefined) formRef.current?.reset();
      return result;
    },
    undefined,
  );

  const inputCls =
    "rounded-lg border border-stone bg-white px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none";

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="month"
        name="month"
        required
        defaultValue={defaultMonth}
        className={inputCls}
      />
      <input
        type="text"
        name="label"
        required
        maxLength={200}
        placeholder="e.g. Upwork"
        className={`${inputCls} min-w-36 flex-1`}
      />
      <input
        type="number"
        name="amount"
        required
        min="0.01"
        step="0.01"
        placeholder="Amount"
        className={`${inputCls} w-28`}
      />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add cost"}
      </button>
      {state?.error && <p className="text-xs text-red-700">{state.error}</p>}
    </form>
  );
}
