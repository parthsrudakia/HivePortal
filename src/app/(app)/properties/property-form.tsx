"use client";

import { useActionState } from "react";
import type { PropertyFormState } from "./actions";

type InitialValues = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  cross_street: string | null;
  neighborhood: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  has_gym: boolean;
  has_elevator: boolean;
  has_parking: boolean;
  has_doorman: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
  amenities_notes: string | null;
  leaseholder_name: string | null;
  cleaner_id: string | null;
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

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="has_gym"
              defaultChecked={v.has_gym ?? false}
              className="accent-accent"
            />
            Gym
          </label>
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="has_elevator"
              defaultChecked={v.has_elevator ?? false}
              className="accent-accent"
            />
            Elevator
          </label>
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="has_parking"
              defaultChecked={v.has_parking ?? false}
              className="accent-accent"
            />
            Parking
          </label>
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="has_doorman"
              defaultChecked={v.has_doorman ?? false}
              className="accent-accent"
            />
            Doorman
          </label>
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="laundry_in_building"
              defaultChecked={v.laundry_in_building ?? false}
              className="accent-accent"
            />
            Laundry in building
          </label>
          <label className={checkboxLabel}>
            <input
              type="checkbox"
              name="in_unit_laundry"
              defaultChecked={v.in_unit_laundry ?? false}
              className="accent-accent"
            />
            In-unit laundry
          </label>
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
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Cleaner</span>
            <select
              name="cleaner_id"
              defaultValue={v.cleaner_id ?? ""}
              className={fieldInput}
            >
              <option value="">— none —</option>
              {cleaners.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.email}
                </option>
              ))}
            </select>
            {cleaners.length === 0 && (
              <span className="text-xs text-muted">
                No cleaners on file. Add one at{" "}
                <em>Notifications → Cleaners</em> first.
              </span>
            )}
          </label>
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
          disabled={pending}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
