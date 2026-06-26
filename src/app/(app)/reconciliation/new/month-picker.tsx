"use client";

import { useEffect, useRef, useState } from "react";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Calendar-style month selector: a button showing the chosen month opens a
 * popover with a 12-month grid and year navigation. Submits the value as a
 * hidden input named `name` in "YYYY-MM" form, so it's a drop-in for the old
 * <input type="month">.
 */
export function MonthPicker({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: string; // "YYYY-MM"
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const selYear = Number(value.slice(0, 4));
  const selMonth = Number(value.slice(5, 7)); // 1–12
  const [viewYear, setViewYear] = useState(selYear);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
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

  const label = new Date(selYear, selMonth - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        onClick={() => {
          setViewYear(selYear);
          setOpen((o) => !o);
        }}
        className="flex w-full items-center justify-between rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink transition hover:border-accent focus:border-accent focus:outline-none"
      >
        <span>{label}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 rounded-xl bg-white p-3 shadow-lg ring-1 ring-stone/50">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              aria-label="Previous year"
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink hover:bg-warm"
            >
              ‹
            </button>
            <span className="text-sm font-medium text-ink">{viewYear}</span>
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              aria-label="Next year"
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink hover:bg-warm"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((mn, idx) => {
              const m = idx + 1;
              const isSelected = viewYear === selYear && m === selMonth;
              return (
                <button
                  key={mn}
                  type="button"
                  onClick={() => {
                    setValue(`${viewYear}-${String(m).padStart(2, "0")}`);
                    setOpen(false);
                  }}
                  className={`rounded-lg px-2 py-2 text-sm transition ${
                    isSelected
                      ? "bg-accent text-white"
                      : "text-ink hover:bg-warm"
                  }`}
                >
                  {mn}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
