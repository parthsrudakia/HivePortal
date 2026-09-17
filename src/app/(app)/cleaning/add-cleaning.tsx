"use client";

import { useActionState, useRef, useState } from "react";
import { addCleaning, type CleaningFormState } from "./actions";
import { todayISO } from "@/lib/date";

export type PropertyOption = {
  id: string;
  label: string;
};

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function AddCleaning({
  properties,
  defaultPropertyId,
  cleaners = [],
}: {
  properties: PropertyOption[];
  defaultPropertyId?: string;
  cleaners?: string[];
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const today = todayISO();

  // Wrapping the server action lets the success path (reset + close) run
  // inside the dispatch instead of a state-watching effect.
  const [state, action, pending] = useActionState<
    CleaningFormState,
    FormData
  >(async (prev, formData) => {
    const result = await addCleaning(prev, formData);
    if (result === undefined) {
      formRef.current?.reset();
      setOpen(false);
    }
    return result;
  }, undefined);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
      >
        Log cleaning
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="rounded-2xl bg-white p-6 shadow-sm"
    >
      <p className="text-xs uppercase tracking-wide text-muted">New cleaning</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {defaultPropertyId ? (
          <input
            type="hidden"
            name="property_id"
            value={defaultPropertyId}
          />
        ) : (
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Property *</span>
            <select
              name="property_id"
              defaultValue=""
              required
              className={fieldInput}
            >
              <option value="" disabled>
                — pick a property —
              </option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Cleaning date *</span>
          <input
            type="date"
            name="cleaning_date"
            defaultValue={today}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Cleaned by</span>
          <select name="assigned_to" defaultValue="" className={fieldInput}>
            <option value="">— unassigned —</option>
            {cleaners.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className={fieldLabel}>Notes</span>
          <input type="text" name="notes" className={fieldInput} />
        </label>
      </div>
      {state?.error && (
        <p className="mt-3 text-sm text-red-700">{state.error}</p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending} aria-busy={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
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
