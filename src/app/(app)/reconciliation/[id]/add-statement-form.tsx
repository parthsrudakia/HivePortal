"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { addStatementToRun, type AddStatementState } from "../actions";

/**
 * "Add statement" disclosure for an unposted run: pick another bank export
 * (an overlapping or later download, a second account) and its deposits are
 * appended to this run — rows the run already has are skipped — then the
 * matches re-derive. Sits with the header actions; collapsed by default.
 */
export function AddStatementForm({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<AddStatementState, FormData>(
    addStatementToRun,
    undefined,
  );

  // Toast the dynamic outcome and close on success.
  const submittedRef = useRef(false);
  useEffect(() => {
    if (pending) {
      submittedRef.current = true;
      return;
    }
    if (!submittedRef.current) return;
    submittedRef.current = false;
    if (state?.error) {
      toast.error(state.error);
    } else {
      toast.success(state?.success ?? "Statement added");
      formRef.current?.reset();
      setOpen(false);
    }
  }, [pending, state]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded-full border border-stone bg-white px-4 py-2 text-sm text-ink shadow-sm hover:bg-warm"
      >
        {open ? "× Cancel" : "+ Add statement"}
      </button>
      {open && (
        <form
          ref={formRef}
          action={action}
          className="absolute right-0 top-full z-30 mt-2 flex w-80 flex-col gap-3 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-stone/40"
        >
          <input type="hidden" name="run_id" value={runId} />
          <p className="text-xs text-muted">
            Upload another bank export for this run. Deposits already in the
            run are skipped, everything else is matched in.
          </p>
          <input
            type="file"
            name="bank_statement"
            required
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
          >
            {pending ? "Matching…" : "Add & re-match"}
          </button>
        </form>
      )}
    </div>
  );
}
