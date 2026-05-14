"use client";

import { useActionState, useEffect, useRef } from "react";
import { addRecipient, type RecipientFormState } from "./actions";

export function AddRecipientForm() {
  const [state, action, pending] = useActionState<RecipientFormState, FormData>(
    addRecipient,
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
      <label className="flex flex-1 min-w-[200px] flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Email
        </span>
        <input
          type="email"
          name="email"
          required
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          placeholder="va@example.com"
        />
      </label>
      <label className="flex flex-1 min-w-[160px] flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Label (optional)
        </span>
        <input
          type="text"
          name="label"
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          placeholder="Sales VA"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add recipient"}
      </button>
      {state?.error && (
        <p className="basis-full text-sm text-red-700">{state.error}</p>
      )}
    </form>
  );
}
