"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

type Result = { ok: true; deleted: number } | { error: string };

/** Master-only "Clear log" button. Confirms, calls the server action, refreshes. */
export function ClearLogButton({
  onClear,
  label,
}: {
  onClear: () => Promise<Result>;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    if (
      !confirm(
        `Clear the entire ${label}? This permanently deletes every entry and cannot be undone.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await onClear();
      if ("error" in res) {
        alert(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending} aria-busy={pending}
      className="shrink-0 rounded-full border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition hover:bg-red-50 disabled:opacity-50"
    >
      {pending ? "Clearing…" : "Clear log"}
    </button>
  );
}
