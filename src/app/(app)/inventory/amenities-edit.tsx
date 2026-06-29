"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { setRoomAmenities, type AmenityValues } from "./actions";

const ROOM_FIELDS: { key: keyof AmenityValues; label: string }[] = [
  { key: "has_private_bathroom", label: "Private bath" },
];

const BUILDING_FIELDS: { key: keyof AmenityValues; label: string }[] = [
  { key: "has_gym", label: "Gym" },
  { key: "has_elevator", label: "Elevator" },
  { key: "has_doorman", label: "Doorman" },
  { key: "has_parking", label: "Parking" },
  { key: "has_rooftop", label: "Rooftop" },
  { key: "has_lounge", label: "Lounge" },
  { key: "laundry_in_building", label: "Laundry in building" },
  { key: "in_unit_laundry", label: "In-unit laundry" },
];

export function InlineAmenitiesEdit({
  roomId,
  propertyId,
  values,
  children,
}: {
  roomId: string;
  propertyId: string | null;
  values: AmenityValues;
  /** The read-only tag display rendered as the trigger. */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AmenityValues>(values);
  const [pending, startTransition] = useTransition();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // After the panel renders we know its real height; nudge it up so the Save
  // button stays on-screen for rows near the bottom of the viewport.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const h = panelRef.current?.offsetHeight ?? 0;
    const clamped = Math.max(12, Math.min(pos.top, window.innerHeight - h - 12));
    if (clamped !== pos.top) {
      setPos((p) => (p ? { ...p, top: clamped } : p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openEditor() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 256;
      const left = Math.min(rect.left, window.innerWidth - width - 12);
      setPos({ top: rect.bottom + 6, left: Math.max(12, left) });
    }
    setDraft(values);
    setOpen(true);
  }

  function toggle(key: keyof AmenityValues) {
    setDraft((d) => ({ ...d, [key]: !d[key] }));
  }

  function save() {
    startTransition(async () => {
      await setRoomAmenities(roomId, propertyId, draft);
      setOpen(false);
      router.refresh();
    });
  }

  const row = (key: keyof AmenityValues, label: string) => (
    <label
      key={key}
      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-ink hover:bg-warm/60"
    >
      <input
        type="checkbox"
        checked={draft[key]}
        onChange={() => toggle(key)}
        className="accent-accent"
      />
      {label}
    </label>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openEditor}
        className="w-full rounded px-1.5 py-0.5 text-left hover:bg-warm/60 focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {children}
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              ref={panelRef}
              className="fixed z-50 flex w-64 flex-col overflow-y-auto rounded-xl bg-white p-3 shadow-xl ring-1 ring-stone/40"
              style={{
                top: pos.top,
                left: pos.left,
                maxHeight: "calc(100vh - 24px)",
              }}
            >
              <p className="px-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Room
              </p>
              {ROOM_FIELDS.map((f) => row(f.key, f.label))}

              <p className="mt-2 px-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Building
              </p>
              {BUILDING_FIELDS.map((f) => row(f.key, f.label))}
              <p className="mt-1 px-1.5 text-xs leading-tight text-muted">
                Building amenities apply to every room in this unit.
              </p>

              <div className="sticky bottom-0 mt-3 flex items-center justify-end gap-2 border-t border-stone/40 bg-white pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full px-3 py-1 text-xs text-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={pending}
                  className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
                >
                  {pending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
