"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setUserAccess } from "./actions";

type Option = { key: string; label: string; description?: string };

/**
 * One user's access as two rows of toggle chips — sections (on unless
 * blocked) and extra permissions (off unless granted). Each click saves.
 */
export function AccessToggles({
  userId,
  sections,
  permissions,
  initialBlocked,
  initialGranted,
}: {
  userId: string;
  sections: Option[];
  permissions: Option[];
  initialBlocked: string[];
  initialGranted: string[];
}) {
  const [blocked, setBlocked] = useState(() => new Set(initialBlocked));
  const [granted, setGranted] = useState(() => new Set(initialGranted));
  const [pending, startTransition] = useTransition();

  function save(nextBlocked: Set<string>, nextGranted: Set<string>) {
    const prevBlocked = blocked;
    const prevGranted = granted;
    setBlocked(nextBlocked);
    setGranted(nextGranted);
    startTransition(async () => {
      const r = await setUserAccess(userId, [...nextBlocked], [...nextGranted]);
      if (r.error) {
        setBlocked(prevBlocked);
        setGranted(prevGranted);
        toast.error(r.error);
      } else if (r.success) {
        toast.success(r.success);
      }
    });
  }

  function toggleSection(key: string, on: boolean) {
    const next = new Set(blocked);
    if (on) next.delete(key);
    else next.add(key);
    save(next, granted);
  }

  function togglePermission(key: string, on: boolean) {
    const next = new Set(granted);
    if (on) next.add(key);
    else next.delete(key);
    save(blocked, next);
  }

  return (
    <div className="flex flex-col gap-3">
      <ChipRow
        title="Sections"
        options={sections}
        isOn={(k) => !blocked.has(k)}
        onToggle={toggleSection}
        pending={pending}
      />
      <ChipRow
        title="Extra access"
        options={permissions}
        isOn={(k) => granted.has(k)}
        onToggle={togglePermission}
        pending={pending}
      />
    </div>
  );
}

function ChipRow({
  title,
  options,
  isOn,
  onToggle,
  pending,
}: {
  title: string;
  options: Option[];
  isOn: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  pending: boolean;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">
        {title}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = isOn(o.key);
          return (
            <label
              key={o.key}
              title={o.description}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide transition ${
                on
                  ? "bg-accent/15 text-accent-text"
                  : "border border-stone bg-white text-muted"
              } ${pending ? "opacity-60" : ""}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={pending}
                onChange={(e) => onToggle(o.key, e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}
