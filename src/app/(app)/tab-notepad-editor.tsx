"use client";

import { useEffect, useState, useTransition } from "react";
import { formatDate } from "@/lib/date";
import { saveTabNote, type NotepadTab } from "./notepad-actions";

// Collapse preference is per-user/per-browser only; the note itself is
// shared. localStorage can throw (private windows) — always guarded.
function storageKey(tab: string) {
  return `tab-notepad-open:${tab}`;
}

export function TabNotepadEditor({
  tab,
  initialContent,
  initialUpdatedAt,
  initialUpdatedBy,
}: {
  tab: NotepadTab;
  initialContent: string;
  initialUpdatedAt: string | null;
  initialUpdatedBy: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [updatedBy, setUpdatedBy] = useState(initialUpdatedBy);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Apply the stored collapse preference after hydration (SSR always
  // renders collapsed, so there's nothing to mismatch).
  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey(tab)) === "1")
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the persisted preference
        setOpen(true);
    } catch {
      // storage unavailable — stay collapsed
    }
  }, [tab]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(storageKey(tab), next ? "1" : "0");
    } catch {
      // storage unavailable — preference just won't persist
    }
  };

  const dirty = content !== savedContent;
  const hasNote = savedContent.trim().length > 0;

  return (
    <div className="mt-6 rounded-2xl bg-white shadow-sm">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          <span
            aria-hidden="true"
            className={`inline-block text-accent-text transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          Notes
          {!open && hasNote && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
              title="This tab has notes"
            />
          )}
          {dirty && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-800">
              unsaved
            </span>
          )}
        </span>
        <span className="text-xs text-muted">
          {updatedAt
            ? `Updated ${formatDate(updatedAt)}${updatedBy ? ` by ${updatedBy}` : ""}`
            : "Shared with everyone"}
        </span>
      </button>

      {open && (
        <div className="border-t border-stone/40 px-5 pb-4 pt-3">
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setError(null);
            }}
            rows={Math.min(14, Math.max(4, content.split("\n").length + 1))}
            placeholder="Shared notes for this tab — everyone sees the same note."
            className="w-full resize-y rounded-lg border border-stone bg-white px-3 py-2 text-sm leading-relaxed text-ink focus:border-accent focus:outline-none"
          />
          {error && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-3">
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setContent(savedContent);
                  setError(null);
                }}
                className="text-xs uppercase tracking-wide text-muted hover:text-ink"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await saveTabNote(tab, content);
                  if (result.error) {
                    setError(result.error);
                    return;
                  }
                  setSavedContent(content);
                  setUpdatedAt(result.updatedAt ?? null);
                  setUpdatedBy(result.updatedBy ?? null);
                })
              }
              className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-white transition hover:bg-accent-dark disabled:opacity-50"
            >
              {pending ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
