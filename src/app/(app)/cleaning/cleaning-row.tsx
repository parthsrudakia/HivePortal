"use client";

import { useActionState, useState } from "react";
import {
  updateCleaning,
  deleteCleaning,
  type CleaningFormState,
} from "./actions";
import type { PropertyOption } from "./add-cleaning";
import { formatDate } from "@/lib/date";

export type CleaningRowData = {
  id: string;
  property_id: string;
  property_label: string | null;
  cleaning_date: string;
  assigned_to: string | null;
  notes: string | null;
};

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function CleaningRow({
  record,
  properties,
  cleaners = [],
  showProperty = true,
}: {
  record: CleaningRowData;
  properties: PropertyOption[];
  cleaners?: string[];
  showProperty?: boolean;
}) {
  // Keep any existing/legacy "cleaned by" value selectable even if that cleaner
  // is no longer in the list.
  const cleanerOptions =
    record.assigned_to && !cleaners.includes(record.assigned_to)
      ? [record.assigned_to, ...cleaners]
      : cleaners;
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateCleaning.bind(null, record.id) as (
    state: CleaningFormState,
    formData: FormData,
  ) => Promise<CleaningFormState>;
  const [state, editAction, pending] = useActionState<
    CleaningFormState,
    FormData
  >(boundUpdate, undefined);

  if (editing) {
    return (
      <li className="rounded-2xl bg-white p-5 shadow-sm">
        <form
          action={async (fd) => {
            const result = await editAction(fd);
            if (result === undefined) setEditing(false);
            return result;
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {showProperty ? (
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Property
                </span>
                <select
                  name="property_id"
                  defaultValue={record.property_id}
                  required
                  className={fieldInput}
                >
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <input
                type="hidden"
                name="property_id"
                value={record.property_id}
              />
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Date
              </span>
              <input
                type="date"
                name="cleaning_date"
                defaultValue={record.cleaning_date}
                required
                className={fieldInput}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Cleaned by
              </span>
              <select
                name="assigned_to"
                defaultValue={record.assigned_to ?? ""}
                className={fieldInput}
              >
                <option value="">— unassigned —</option>
                {cleanerOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Notes
              </span>
              <input
                type="text"
                name="notes"
                defaultValue={record.notes ?? ""}
                className={fieldInput}
              />
            </label>
          </div>
          {state?.error && (
            <p className="mt-3 text-sm text-red-700">{state.error}</p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={pending} aria-busy={pending}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-base text-ink">{formatDate(record.cleaning_date)}</span>
          {record.assigned_to && (
            <span className="text-xs uppercase tracking-wide text-muted">
              by {record.assigned_to}
            </span>
          )}
        </div>
        {showProperty && record.property_label && (
          <p className="mt-0.5 text-xs text-muted">{record.property_label}</p>
        )}
        {record.notes && (
          <p className="mt-1 text-xs text-muted">{record.notes}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
        >
          Edit
        </button>
        <form action={deleteCleaning}>
          <input type="hidden" name="id" value={record.id} />
          <input type="hidden" name="property_id" value={record.property_id} />
          <button
            type="submit"
            onClick={(e) => {
              if (!confirm("Delete this cleaning record?")) e.preventDefault();
            }}
            className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
          >
            Delete
          </button>
        </form>
      </div>
    </li>
  );
}
