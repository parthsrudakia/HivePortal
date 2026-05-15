"use client";

import { useActionState } from "react";
import { createTenant, type TenantFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";

type RoomOption = {
  id: string;
  label: string;
  total_rent: number | null;
};

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function AddTenantForm({
  rooms,
  defaultRoomId = "",
}: {
  rooms: RoomOption[];
  defaultRoomId?: string;
}) {
  const [state, action, pending] = useActionState<TenantFormState, FormData>(
    createTenant,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Tenant added" });

  return (
    <form action={action} className="flex flex-col gap-8">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Tenant
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Full name *</span>
            <input
              type="text"
              name="full_name"
              required
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Email</span>
            <input type="email" name="email" className={fieldInput} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Phone</span>
            <input type="tel" name="phone" className={fieldInput} />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>
              Pays as (name on Zelle deposits)
            </span>
            <input
              type="text"
              name="pays_as"
              placeholder="Leave blank to use the full name above"
              className={fieldInput}
            />
            <span className="text-xs text-muted">
              Used by reconciliation to match bank deposits. Match what shows up on
              the bank statement, e.g. <em>JANE DOE</em> or <em>J DOE</em>.
            </span>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Notes</span>
            <textarea name="notes" rows={2} className={`${fieldInput} resize-y`} />
          </label>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Assign to a room (optional)
        </h2>
        <p className="mt-1 text-xs text-muted">
          Pick an available room to start a tenancy now, or leave blank and assign
          later.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Room</span>
            <select
              name="room_id"
              defaultValue={defaultRoomId}
              className={fieldInput}
            >
              <option value="">— none —</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.total_rent ? ` — $${r.total_rent.toLocaleString()}` : ""}
                </option>
              ))}
            </select>
            {rooms.length === 0 && (
              <span className="text-xs text-muted">
                No available rooms. Add a property + room first, or set a room&apos;s
                status to Available.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Monthly rent ($)</span>
            <input
              type="number"
              name="monthly_rent"
              min="0"
              step="1"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Security deposit ($)</span>
            <input
              type="number"
              name="security_deposit"
              min="0"
              step="1"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Start date</span>
            <input type="date" name="start_date" className={fieldInput} />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>
              First month rent (optional — leave blank if not prorated)
            </span>
            <input
              type="number"
              name="first_month_rent"
              min="0"
              step="1"
              placeholder="e.g. 1207 if they're moving in mid-month"
              className={fieldInput}
            />
            <span className="text-xs text-muted">
              Used only for the calendar month the tenancy starts in. Every
              month after that uses the monthly rent above.
            </span>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Lease PDF (optional)</span>
            <input
              type="file"
              name="lease_pdf"
              accept="application/pdf"
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark"
            />
            <span className="text-xs text-muted">
              PDF only, up to 20 MB. Attached to the tenancy you create above.
            </span>
          </label>
        </div>
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
          {pending ? "Saving…" : "Save tenant"}
        </button>
      </div>
    </form>
  );
}
