"use client";

import { useActionState } from "react";
import { runReconciliation, type RunFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";
import { MonthPicker } from "./month-picker";

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fileInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark";

export function RunReconciliationForm({
  defaultMonth,
}: {
  defaultMonth: string;
}) {
  const [state, action, pending] = useActionState<RunFormState, FormData>(
    runReconciliation,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Reconciliation complete" });

  return (
    <form action={action} className="flex flex-col gap-6">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          1 · Pick the month
        </h2>
        <p className="mt-1 text-xs text-muted">
          Reconciliation runs against tenants whose tenancy was active in this month.
        </p>
        <label className="mt-4 flex flex-col gap-1.5 sm:max-w-xs">
          <span className={fieldLabel}>Month *</span>
          <MonthPicker name="month" defaultValue={defaultMonth} />
        </label>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          2 · Upload bank statement
        </h2>
        <p className="mt-1 text-xs text-muted">
          CSV or Excel. We auto-detect the header row — any row with{" "}
          <code>Description</code> + <code>Amount</code> columns works. All
          positive-amount deposits are matched; payments that don&apos;t
          match a tenant&apos;s <code>pays as</code> show up as unmatched.
        </p>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className={fieldLabel}>Bank statement *</span>
          <input
            type="file"
            name="bank_statement"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            required
            className={fileInput}
          />
        </label>
      </section>

      {state?.error && (
        <p className="text-sm text-red-700">{state.error}</p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Reconciling…" : "Run reconciliation"}
        </button>
      </div>
    </form>
  );
}
