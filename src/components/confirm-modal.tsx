"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  trigger: React.ReactNode;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
};

/** Branded confirm dialog. Wraps `trigger` so clicking it opens the modal
 *  instead of immediately firing the action. */
export function ConfirmModal({
  trigger,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // Focus confirm after mount.
    queueMicrotask(() => confirmRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const triggerWithHandler = (
    <span
      onClick={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {trigger}
    </span>
  );

  const modal = open && mounted ? (
    createPortal(
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center px-4"
      >
        <div
          className="absolute inset-0 bg-ink/40"
          onClick={() => !busy && setOpen(false)}
        />
        <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
          <h3 className="text-lg tracking-tight text-ink">{title}</h3>
          <div className="mt-2 text-sm text-muted">{message}</div>
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => !busy && setOpen(false)}
              className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-ink"
            >
              {cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={handleConfirm}
              disabled={busy}
              className={`rounded-full px-4 py-1.5 text-sm font-medium text-white shadow-sm transition disabled:opacity-50 ${
                destructive
                  ? "bg-red-700 hover:bg-red-800"
                  : "bg-ink hover:bg-accent-dark"
              }`}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  ) : null;

  return (
    <>
      {triggerWithHandler}
      {modal}
    </>
  );
}
