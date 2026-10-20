"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setUserSections } from "./actions";

type Section = { key: string; label: string };

/** One user's row of section checkboxes; each change saves immediately. */
export function SectionToggles({
  userId,
  sections,
  initialBlocked,
}: {
  userId: string;
  sections: Section[];
  initialBlocked: string[];
}) {
  const [blocked, setBlocked] = useState(() => new Set(initialBlocked));
  const [pending, startTransition] = useTransition();

  function toggle(key: string, allowed: boolean) {
    const prev = blocked;
    const next = new Set(prev);
    if (allowed) next.delete(key);
    else next.add(key);
    setBlocked(next);
    startTransition(async () => {
      const r = await setUserSections(userId, [...next]);
      if (r.error) {
        setBlocked(prev);
        toast.error(r.error);
      } else if (r.success) {
        toast.success(r.success);
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      {sections.map((s) => {
        const allowed = !blocked.has(s.key);
        return (
          <label
            key={s.key}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide transition ${
              allowed
                ? "bg-accent/15 text-accent-text"
                : "border border-stone bg-white text-muted line-through"
            } ${pending ? "opacity-60" : ""}`}
          >
            <input
              type="checkbox"
              checked={allowed}
              disabled={pending}
              onChange={(e) => toggle(s.key, e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            {s.label}
          </label>
        );
      })}
    </div>
  );
}
