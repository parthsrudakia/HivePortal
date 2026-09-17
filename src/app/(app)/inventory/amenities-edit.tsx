"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { setRoomAmenities, type AmenityValues } from "./actions";
import { UNIT_AMENITIES, BUILDING_AMENITIES } from "@/lib/amenities";

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

  function toggleList(
    key: "unit_amenities" | "building_amenities",
    value: string,
  ) {
    setDraft((d) => ({
      ...d,
      [key]: d[key].includes(value)
        ? d[key].filter((v) => v !== value)
        : [...d[key], value],
    }));
  }

  function save() {
    startTransition(async () => {
      await setRoomAmenities(roomId, propertyId, draft);
      setOpen(false);
      router.refresh();
    });
  }

  const row = (checked: boolean, label: string, onToggle: () => void) => (
    <label
      key={label}
      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-ink hover:bg-warm/60"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
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
        className="w-full rounded px-1.5 py-0.5 text-center hover:bg-warm/60 focus:outline-none focus:ring-1 focus:ring-accent"
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
              {row(draft.has_private_bathroom, "Private bath", () =>
                setDraft((d) => ({
                  ...d,
                  has_private_bathroom: !d.has_private_bathroom,
                })),
              )}
              {row(draft.has_ac, "AC", () =>
                setDraft((d) => ({ ...d, has_ac: !d.has_ac })),
              )}

              <p className="mt-2 px-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Unit amenities
              </p>
              {UNIT_AMENITIES.map((a) =>
                row(draft.unit_amenities.includes(a), a, () =>
                  toggleList("unit_amenities", a),
                ),
              )}

              <p className="mt-2 px-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Building amenities
              </p>
              {BUILDING_AMENITIES.map((a) =>
                row(draft.building_amenities.includes(a), a, () =>
                  toggleList("building_amenities", a),
                ),
              )}
              <p className="mt-1 px-1.5 text-xs leading-tight text-muted">
                Unit &amp; building amenities apply to every room in this unit.
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
                  disabled={pending} aria-busy={pending}
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
