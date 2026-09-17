"use client";

import { useActionState, useState } from "react";
import { setRoomRent, type RentFormState } from "../actions";

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return `$${n.toLocaleString()}`;
}

export function RentEdit({
  roomId,
  baseRent,
  bundleFee,
  totalRent,
}: {
  roomId: string;
  baseRent: number | null;
  bundleFee: number | null;
  totalRent: number | null;
}) {
  const [editing, setEditing] = useState(false);

  const bound = setRoomRent.bind(null, roomId) as (
    state: RentFormState,
    formData: FormData,
  ) => Promise<RentFormState>;
  const [state, action, pending] = useActionState<RentFormState, FormData>(
    bound,
    undefined,
  );

  if (!editing) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Rent
          </h2>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-stone bg-white px-3 py-1 text-xs uppercase tracking-wide text-ink hover:bg-warm"
          >
            Edit
          </button>
        </div>
        <div className="mt-4 flex items-baseline gap-2">
          <span className="text-4xl font-light text-ink">
            {fmtMoney(totalRent)}
          </span>
          <span className="text-xs text-muted">/ month</span>
        </div>
        <p className="mt-2 text-xs text-muted">
          Base {fmtMoney(baseRent)} + Services {fmtMoney(bundleFee)}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        Edit rent
      </h2>
      <form
        action={async (fd) => {
          const result = await action(fd);
          if (result === undefined) setEditing(false);
          return result;
        }}
        className="mt-4 grid gap-3 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Base rent ($) *</span>
          <input
            type="number"
            name="base_rent"
            min="0"
            step="1"
            defaultValue={baseRent ?? ""}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Services ($)</span>
          <input
            type="number"
            name="bundle_fee"
            min="0"
            step="1"
            defaultValue={bundleFee ?? 125}
            className={fieldInput}
          />
        </label>
        {state?.error && (
          <p className="text-sm text-red-700 sm:col-span-2">{state.error}</p>
        )}
        <div className="flex items-center gap-3 sm:col-span-2">
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
    </div>
  );
}
