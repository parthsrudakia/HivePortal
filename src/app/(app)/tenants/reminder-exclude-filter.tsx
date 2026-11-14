"use client";

import { useEffect, useRef, useState } from "react";

export type OwingTenant = { id: string; name: string; balance: number };

const fmt = (n: number) =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * One exclude list shared by the bulk email and text balance reminders: tick
 * the tenants who should NOT be reminded this time.
 */
export function ReminderExcludeFilter({
  tenants,
  excluded,
  onChange,
  disabled = false,
}: {
  tenants: OwingTenant[];
  excluded: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q ? tenants.filter((t) => t.name.toLowerCase().includes(q)) : tenants;
  const toggle = (id: string) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || tenants.length === 0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide transition disabled:opacity-50 ${
          excluded.size > 0
            ? "border-accent bg-accent/10 text-accent-text"
            : "border-stone bg-white text-ink hover:bg-warm"
        }`}
      >
        {excluded.size > 0 ? `Excluding ${excluded.size}` : "Exclude tenants"}
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-white p-3 shadow-lg ring-1 ring-stone/40">
          <p className="text-xs text-muted">
            Ticked tenants are skipped by both the email and text reminders.
          </p>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tenants"
            className="mt-2 w-full rounded-lg border border-stone bg-white px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
          />
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {shown.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-cream">
                  <input
                    type="checkbox"
                    checked={excluded.has(t.id)}
                    onChange={() => toggle(t.id)}
                    className="accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="tabular-nums text-xs text-muted">{fmt(t.balance)}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted">No matches.</li>
            )}
          </ul>
          {excluded.size > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="mt-2 text-xs font-medium text-accent-text underline underline-offset-2 hover:text-accent-dark"
            >
              Clear exclusions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
