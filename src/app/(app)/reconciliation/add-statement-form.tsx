"use client";

import { useActionState, useRef, useState } from "react";
import { toast } from "sonner";
import { addStatement, type AddStatementState } from "./actions";

function fmtDate(s: string) {
  const [y, m, d] = s.slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y}` : s;
}

/**
 * "Add statement" disclosure: upload the next bank export (overlapping is
 * fine — known transactions are skipped) and matched deposits post to tenant
 * ledgers immediately. Shows how far the last statement reached so the
 * operator knows where to start the next export.
 */
export function AddStatementForm({
  coversThrough,
}: {
  coversThrough: string | null;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // The wrapper toasts the outcome and closes on success inside the action
  // dispatch itself, instead of watching pending/state from an effect.
  const [, action, pending] = useActionState<AddStatementState, FormData>(
    async (prev, formData) => {
      const result = await addStatement(prev, formData);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(result?.success ?? "Statement added");
        formRef.current?.reset();
        setOpen(false);
      }
      return result;
    },
    undefined,
  );

  return (
    <div className="relative flex items-center gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
      >
        {open ? "× Cancel" : "+ Add statement"}
      </button>
      {coversThrough && (
        <p className="whitespace-nowrap text-xs text-muted">
          Last statement covers till{" "}
          <span className="font-medium text-ink">{fmtDate(coversThrough)}</span>
        </p>
      )}
      {open && (
        <form
          ref={formRef}
          action={action}
          className="absolute right-0 top-full z-30 mt-2 flex w-80 flex-col gap-3 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-stone/40"
        >
          <p className="text-xs text-muted">
            Upload a bank export. Matched deposits post to tenant ledgers
            immediately. Overlap is fine: known transactions are skipped.
          </p>
          <input
            type="file"
            name="bank_statement"
            required
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark"
          />
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-ink">
              Other payments file (optional)
            </summary>
            <input
              type="file"
              name="other_payments"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="mt-2 w-full rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark"
            />
            <p className="mt-1 text-[11px] text-muted">
              Venmo / cash / ClickPay exports — the Description column is the
              payer&apos;s name.
            </p>
          </details>
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Posting…" : "Add & Post"}
          </button>
        </form>
      )}
    </div>
  );
}
