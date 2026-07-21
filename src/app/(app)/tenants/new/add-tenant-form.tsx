"use client";

import { useActionState } from "react";
import { createTenant, type TenantFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";
import { RoomCombobox } from "./room-combobox";

type RoomOption = {
  id: string;
  label: string;
  total_rent: number | null;
};

// Prefill carried over from a signed agreement in the /agreements tally.
export type AgreementPrefill = {
  agreementRequestId: string;
  fullName: string;
  email: string;
  monthlyRent: string;
  securityDeposit: string;
  startDate: string;
  leaseEndDate: string;
  firstMonthRent: string;
};

// Keep in sync with MAX_LEASE_PDF_BYTES in ../actions.ts.
const MAX_LEASE_PDF_BYTES = 20 * 1024 * 1024;

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export function AddTenantForm({
  rooms,
  defaultRoomId = "",
  agreementPrefill = null,
}: {
  rooms: RoomOption[];
  defaultRoomId?: string;
  agreementPrefill?: AgreementPrefill | null;
}) {
  const [state, action, pending] = useActionState<TenantFormState, FormData>(
    createTenant,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Tenant added" });

  return (
    <form action={action} className="flex flex-col gap-8">
      {agreementPrefill && (
        <>
          <input
            type="hidden"
            name="agreement_request_id"
            value={agreementPrefill.agreementRequestId}
          />
          <p className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-ink">
            Prefilled from {agreementPrefill.fullName}&rsquo;s signed
            agreement. Pick a room below and the signed PDF attaches to the
            tenancy automatically.
          </p>
        </>
      )}
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
              defaultValue={agreementPrefill?.fullName}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Email</span>
            <input
              type="email"
              name="email"
              defaultValue={agreementPrefill?.email}
              className={fieldInput}
            />
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
            <RoomCombobox rooms={rooms} defaultRoomId={defaultRoomId} />
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
              step="0.01"
              defaultValue={agreementPrefill?.monthlyRent}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Security deposit ($)</span>
            <input
              type="number"
              name="security_deposit"
              min="0"
              step="0.01"
              defaultValue={agreementPrefill?.securityDeposit}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Start date</span>
            <input
              type="date"
              name="start_date"
              defaultValue={agreementPrefill?.startDate}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Lease end date (optional)</span>
            <input
              type="date"
              name="lease_end_date"
              defaultValue={agreementPrefill?.leaseEndDate}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Prorated Rent (optional)</span>
            <input
              type="number"
              name="first_month_rent"
              min="0"
              step="0.01"
              placeholder="e.g. 1207 if they're moving in mid-month"
              defaultValue={agreementPrefill?.firstMonthRent}
              className={fieldInput}
            />
            <span className="text-xs text-muted">
              Used only for the calendar month the tenancy starts in. Leave
              blank to charge the full monthly rent above; every later month
              uses the monthly rent regardless.
            </span>
          </label>
          {agreementPrefill ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className={fieldLabel}>Lease PDF</span>
              <p className="rounded-lg border border-stone bg-warm/50 px-3 py-2 text-sm text-ink">
                The signed agreement is attached automatically when you save.
              </p>
            </div>
          ) : (
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Lease PDF (optional)</span>
            <input
              type="file"
              name="lease_pdf"
              accept="application/pdf"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.setCustomValidity(
                  file && file.size > MAX_LEASE_PDF_BYTES
                    ? "Lease PDF must be 20 MB or smaller."
                    : "",
                );
              }}
              className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark"
            />
            <span className="text-xs text-muted">
              PDF only, up to 20 MB. Attached to the tenancy you create above.
            </span>
          </label>
          )}
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
