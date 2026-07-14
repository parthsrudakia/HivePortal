"use client";

import { useActionState, useRef } from "react";
import { addLineItem, type LineItemFormState } from "./actions";

/** One-row form to append a manual revenue or expense line to the summary. */
export function LineItemForm({ year }: { year: number }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<LineItemFormState, FormData>(
    async (prev, formData) => {
      const result = await addLineItem(prev, formData);
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
      <input type="hidden" name="year" value={year} />
      <select name="side" defaultValue="expense" className={inputCls}>
        <option value="revenue">Revenue</option>
        <option value="expense">Expense</option>
      </select>
      <input
        type="text"
        name="label"
        required
        placeholder={`e.g. Admin costs (${year})`}
        className={`${inputCls} min-w-44 flex-1`}
      />
      <input
        type="number"
        name="amount"
        required
        min="0.01"
        step="0.01"
        placeholder="Amount / yr"
        className={`${inputCls} w-32`}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add line item"}
      </button>
      {state?.error && <p className="text-xs text-red-700">{state.error}</p>}
    </form>
  );
}
