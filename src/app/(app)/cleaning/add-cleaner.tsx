"use client";

import { useActionState, useEffect, useRef } from "react";
import { addCleaner, type CleanerFormState } from "./cleaners-actions";

export function AddCleanerForm() {
  const [state, action, pending] = useActionState<CleanerFormState, FormData>(
    addCleaner,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    submittedRef.current = pending;
  }, [pending, state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="flex flex-1 min-w-[140px] flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Name
        </span>
        <input
          type="text"
          name="name"
          required
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <label className="flex flex-1 min-w-[180px] flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Email
        </span>
        <input
          type="email"
          name="email"
          required
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <label className="flex flex-1 min-w-[140px] flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Phone (optional)
        </span>
        <input
          type="tel"
          name="phone"
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add cleaner"}
      </button>
      {state?.error && (
        <p className="basis-full text-sm text-red-700">{state.error}</p>
      )}
    </form>
  );
}
