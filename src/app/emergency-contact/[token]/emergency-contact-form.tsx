"use client";

import { useState, useTransition } from "react";
import {
  emergencyContactSchema,
  type EmergencyContactInput,
} from "@/lib/emergency-contact";
import { submitEmergencyContact } from "./actions";

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "w-full rounded-lg border bg-white px-3 py-2.5 text-base text-ink focus:border-accent focus:outline-none sm:text-sm";

type Field = keyof EmergencyContactInput;

const FIELDS: {
  name: Field;
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
}[] = [
  { name: "contactName", label: "Full name", type: "text", autoComplete: "off", placeholder: "Jane Doe" },
  { name: "relationship", label: "Relationship to you", type: "text", autoComplete: "off", placeholder: "Mother, Brother, Friend…" },
  { name: "contactEmail", label: "Email", type: "email", autoComplete: "off", placeholder: "jane@example.com" },
  { name: "contactPhone", label: "Phone number", type: "tel", autoComplete: "off", placeholder: "+1 555 123 4567" },
];

export function EmergencyContactForm({
  token,
  initial,
  alreadySubmitted,
}: {
  token: string;
  initial: EmergencyContactInput;
  alreadySubmitted: boolean;
}) {
  const [values, setValues] = useState<EmergencyContactInput>(initial);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <div className="text-center">
        <h2 className="text-xl font-medium text-ink">Thank you!</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          We&rsquo;ve saved {values.contactName} as your emergency contact. You
          can come back to this link any time to update it.
        </p>
        <button
          type="button"
          onClick={() => setDone(false)}
          className="mt-6 text-sm font-medium text-accent-text hover:underline"
        >
          Edit my answers
        </button>
      </div>
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = emergencyContactSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as Field;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const res = await submitEmergencyContact(token, parsed.data);
      if (res.ok) {
        setDone(true);
        return;
      }
      setErrors((res.fieldErrors ?? {}) as Partial<Record<Field, string>>);
      setFormError(res.fieldErrors ? null : res.error);
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {alreadySubmitted && (
        <p className="rounded-lg bg-warm/60 px-4 py-3 text-sm text-ink">
          You&rsquo;ve already sent us your emergency contact. You can update
          it below.
        </p>
      )}
      {FIELDS.map((f) => {
        const err = errors[f.name];
        return (
          <label key={f.name} className="flex flex-col gap-1.5">
            <span className={fieldLabel}>
              {f.label} <span className="text-accent-text">*</span>
            </span>
            <input
              type={f.type}
              name={f.name}
              required
              autoComplete={f.autoComplete}
              placeholder={f.placeholder}
              value={values[f.name]}
              onChange={(e) => {
                const v = e.target.value;
                setValues((prev) => ({ ...prev, [f.name]: v }));
                if (err) setErrors((prev) => ({ ...prev, [f.name]: undefined }));
              }}
              aria-invalid={err ? true : undefined}
              className={`${fieldInput} ${err ? "border-red-500" : "border-stone"}`}
            />
            {err && <span className="text-xs text-red-600">{err}</span>}
          </label>
        );
      })}

      {formError && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-full bg-accent px-6 py-3 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-60"
      >
        {pending ? "Saving…" : alreadySubmitted ? "Update emergency contact" : "Save emergency contact"}
      </button>
    </form>
  );
}
