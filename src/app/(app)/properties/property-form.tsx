"use client";

import { useActionState } from "react";
import type { PropertyFormState } from "./actions";
import { UNIT_AMENITIES, BUILDING_AMENITIES } from "@/lib/amenities";

type InitialValues = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  cross_street: string | null;
  neighborhood: string | null;
  is_new_york: boolean;
  bedrooms: number | null;
  bathrooms: number | null;
  unit_rent: number | null;
  unit_lease_start: string | null;
  unit_lease_end: string | null;
  amenity_fees_yearly: number | null;
  misc_fees_yearly: number | null;
  internet_monthly: number | null;
  cleaning_fee_monthly: number | null;
  insurance_monthly: number | null;
  unit_amenities: string[];
  building_amenities: string[];
  amenities_notes: string | null;
  leaseholder_name: string | null;
  cleaner_ids: string[];
  notes: string | null;
};

export type CleanerOption = { id: string; name: string; email: string };

const KNOWN_NEIGHBORHOODS = [
  "JSQ",
  "UWS",
  "UES",
  "FiDi",
  "Midtown",
  "Midtown East",
  "Midtown West",
  "Chelsea",
  "Tribeca",
  "Battery Park",
  "Harlem",
];

type Props = {
  action: (
    state: PropertyFormState,
    formData: FormData,
  ) => Promise<PropertyFormState>;
  knownLeaseholders: string[];
  cleaners: CleanerOption[];
  initial?: Partial<InitialValues>;
  submitLabel: string;
};

const fieldLabel =
  "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const checkboxLabel =
  "flex items-center gap-2 rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink";

export function PropertyForm({
  action,
  knownLeaseholders,
  cleaners,
  initial,
  submitLabel,
}: Props) {
  const [state, formAction, pending] = useActionState<
    PropertyFormState,
    FormData
  >(action, undefined);

  const v = initial ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Unit identity
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Building name (optional)</span>
            <input
              type="text"
              name="building_name"
              defaultValue={v.building_name ?? ""}
              placeholder="e.g. MetroVue, Avalon Midtown West"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Street address *</span>
            <input
              type="text"
              name="street_address"
              defaultValue={v.street_address ?? ""}
              required
              placeholder="e.g. 90 Washington St"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Unit number *</span>
            <input
              type="text"
              name="unit_number"
              defaultValue={v.unit_number ?? ""}
              required
              placeholder="e.g. 24M, 1001, 8E"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Cross street</span>
            <input
              type="text"
              name="cross_street"
              defaultValue={v.cross_street ?? ""}
              placeholder="e.g. Washington &amp; Wall"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Neighborhood</span>
            <input
              type="text"
              name="neighborhood"
              defaultValue={v.neighborhood ?? ""}
              list="neighborhoods"
              placeholder="JSQ / UWS / FiDi / Midtown"
              className={fieldInput}
            />
            <datalist id="neighborhoods">
              {KNOWN_NEIGHBORHOODS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <label className={`${checkboxLabel} sm:col-span-2`}>
            <input
              type="checkbox"
              name="is_new_york"
              defaultChecked={v.is_new_york ?? false}
              className="accent-accent"
            />
            <span className="flex flex-col">
              New York apartment
              <span className="text-xs font-normal text-muted">
                Reminders &amp; agreements to these tenants come from Vineet&apos;s
                personal email — plain text, unbranded.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Unit properties
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Bedrooms</span>
            <input
              type="number"
              name="bedrooms"
              min="0"
              step="1"
              defaultValue={v.bedrooms ?? ""}
              className={fieldInput}
            />
            <span className="text-xs text-muted">
              One room per bedroom is created automatically — fill in each
              room&apos;s details on the property page.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Bathrooms</span>
            <input
              type="number"
              name="bathrooms"
              min="0"
              step="0.5"
              defaultValue={v.bathrooms ?? ""}
              className={fieldInput}
            />
          </label>
        </div>

        <p className="mt-6 text-xs font-medium uppercase tracking-wide text-muted">
          Unit amenities
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {UNIT_AMENITIES.map((a) => (
            <label key={a} className={checkboxLabel}>
              <input
                type="checkbox"
                name="unit_amenities"
                value={a}
                defaultChecked={(v.unit_amenities ?? []).includes(a)}
                className="accent-accent"
              />
              {a}
            </label>
          ))}
        </div>

        <p className="mt-6 text-xs font-medium uppercase tracking-wide text-muted">
          Building amenities
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {BUILDING_AMENITIES.map((a) => (
            <label key={a} className={checkboxLabel}>
              <input
                type="checkbox"
                name="building_amenities"
                value={a}
                defaultChecked={(v.building_amenities ?? []).includes(a)}
                className="accent-accent"
              />
              {a}
            </label>
          ))}
        </div>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className={fieldLabel}>Other amenities notes</span>
          <input
            type="text"
            name="amenities_notes"
            defaultValue={v.amenities_notes ?? ""}
            placeholder="e.g. Rooftop, concierge, pet-friendly"
            className={fieldInput}
          />
        </label>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Lease &amp; notes
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Unit rent ($ / month)</span>
            <input
              type="number"
              name="unit_rent"
              min="0"
              step="0.01"
              defaultValue={v.unit_rent ?? ""}
              placeholder="e.g. 6500"
              className={fieldInput}
            />
          </label>
          <div className="hidden sm:block" />
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Unit lease start</span>
            <input
              type="date"
              name="unit_lease_start"
              defaultValue={v.unit_lease_start ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Unit lease end</span>
            <input
              type="date"
              name="unit_lease_end"
              defaultValue={v.unit_lease_end ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Amenity fees ($ / year)</span>
            <input
              type="number"
              name="amenity_fees_yearly"
              min="0"
              step="0.01"
              defaultValue={v.amenity_fees_yearly ?? ""}
              placeholder="e.g. 1200"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Misc fees ($ / year)</span>
            <input
              type="number"
              name="misc_fees_yearly"
              min="0"
              step="0.01"
              placeholder="e.g. 300"
              defaultValue={v.misc_fees_yearly ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Internet ($ / month)</span>
            <input
              type="number"
              name="internet_monthly"
              min="0"
              step="0.01"
              placeholder="e.g. 60"
              defaultValue={v.internet_monthly ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Cleaning ($ / month)</span>
            <input
              type="number"
              name="cleaning_fee_monthly"
              min="0"
              step="0.01"
              placeholder="e.g. 60"
              defaultValue={v.cleaning_fee_monthly ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Insurance ($ / month)</span>
            <input
              type="number"
              name="insurance_monthly"
              min="0"
              step="0.01"
              placeholder="e.g. 20"
              defaultValue={v.insurance_monthly ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Leaseholder (whose name the lease is in)</span>
            <input
              type="text"
              name="leaseholder_name"
              defaultValue={v.leaseholder_name ?? ""}
              list="known-leaseholders"
              placeholder="e.g. Vinny, Nehal, Suman"
              className={fieldInput}
            />
            <datalist id="known-leaseholders">
              {knownLeaseholders.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Cleaners</span>
            {cleaners.length === 0 ? (
              <span className="text-xs text-muted">
                No cleaners on file. Add one at{" "}
                <em>Cleaning → Cleaners</em> first.
              </span>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {cleaners.map((c) => (
                  <label key={c.id} className={checkboxLabel}>
                    <input
                      type="checkbox"
                      name="cleaner_ids"
                      value={c.id}
                      defaultChecked={(v.cleaner_ids ?? []).includes(c.id)}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="min-w-0 truncate">
                      {c.name}
                      <span className="text-muted"> — {c.email}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <span className="text-xs text-muted">
              Assign one or more cleaners. Each is emailed when this unit&apos;s
              cleaning schedule changes.
            </span>
          </div>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Notes</span>
            <textarea
              name="notes"
              defaultValue={v.notes ?? ""}
              rows={3}
              className={`${fieldInput} resize-y`}
            />
          </label>
        </div>
      </section>

      {state?.error && (
        <p className="text-sm text-red-700">{state.error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending} aria-busy={pending}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
