"use client";

import { useActionState, useState } from "react";
import { updateTenant, type TenantFormState } from "../actions";
import { useFormToast } from "@/components/use-form-toast";

type Props = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  pays_as: string | null;
  notes: string | null;
  age: number | null;
  profession: string | null;
  linkedin_url: string | null;
  instagram_url: string | null;
};

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

export function TenantInfo(props: Props) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateTenant.bind(null, props.id) as (
    state: TenantFormState,
    formData: FormData,
  ) => Promise<TenantFormState>;
  const [state, action, pending] = useActionState<TenantFormState, FormData>(
    boundUpdate,
    undefined,
  );
  useFormToast({ pending, state, successMessage: "Tenant updated" });

  if (!editing) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Contact
          </h2>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
          >
            Edit
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-y-3 text-sm">
          <dt className="text-muted">Email</dt>
          <dd className="col-span-2 text-ink">{props.email ?? "—"}</dd>
          <dt className="text-muted">Phone</dt>
          <dd className="col-span-2 text-ink">{props.phone ?? "—"}</dd>
          <dt className="text-muted">Pays as</dt>
          <dd className="col-span-2 text-ink">
            {props.pays_as ?? (
              <span className="text-muted">
                — (falls back to <em>{props.full_name}</em>)
              </span>
            )}
          </dd>
          <dt className="text-muted">Age</dt>
          <dd className="col-span-2 text-ink">{props.age ?? "—"}</dd>
          <dt className="text-muted">Profession</dt>
          <dd className="col-span-2 text-ink">{props.profession ?? "—"}</dd>
          <dt className="text-muted">LinkedIn</dt>
          <dd className="col-span-2 text-ink">
            {props.linkedin_url ? (
              <a
                href={props.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-text hover:underline"
              >
                {props.linkedin_url}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-muted">Instagram</dt>
          <dd className="col-span-2 text-ink">
            {props.instagram_url ? (
              <a
                href={props.instagram_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-text hover:underline"
              >
                {props.instagram_url}
              </a>
            ) : (
              "—"
            )}
          </dd>
          {props.notes && (
            <>
              <dt className="text-muted">Notes</dt>
              <dd className="col-span-2 whitespace-pre-wrap text-ink">
                {props.notes}
              </dd>
            </>
          )}
        </dl>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        Edit contact
      </h2>
      <form
        action={async (fd) => {
          const result = await action(fd);
          if (result === undefined) setEditing(false);
          return result;
        }}
        className="mt-4 grid gap-3"
      >
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Full name *</span>
          <input
            type="text"
            name="full_name"
            defaultValue={props.full_name}
            required
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Email</span>
          <input
            type="email"
            name="email"
            defaultValue={props.email ?? ""}
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Phone</span>
          <input
            type="tel"
            name="phone"
            defaultValue={props.phone ?? ""}
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Pays as (name on bank deposit)</span>
          <input
            type="text"
            name="pays_as"
            defaultValue={props.pays_as ?? ""}
            placeholder="Leave blank to use the full name"
            className={fieldInput}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Age</span>
            <input
              type="number"
              name="age"
              min={0}
              max={150}
              step={1}
              defaultValue={props.age ?? ""}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Profession</span>
            <input
              type="text"
              name="profession"
              defaultValue={props.profession ?? ""}
              placeholder="e.g. Product Designer"
              className={fieldInput}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>LinkedIn URL</span>
          <input
            type="url"
            name="linkedin_url"
            defaultValue={props.linkedin_url ?? ""}
            placeholder="https://linkedin.com/in/…"
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Instagram URL</span>
          <input
            type="url"
            name="instagram_url"
            defaultValue={props.instagram_url ?? ""}
            placeholder="https://instagram.com/…"
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Notes</span>
          <textarea
            name="notes"
            defaultValue={props.notes ?? ""}
            rows={2}
            className={`${fieldInput} resize-y`}
          />
        </label>
        {state?.error && (
          <p className="text-sm text-red-700">{state.error}</p>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-50"
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
