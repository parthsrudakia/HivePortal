"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreListing } from "../../inventory/actions";

/** Undo a deleted listing — return the room to the Inventory table. */
export function RestoreListingButton({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending} aria-busy={pending}
      onClick={() =>
        startTransition(async () => {
          await restoreListing(roomId);
          router.refresh();
        })
      }
      className="text-xs uppercase tracking-wide text-muted hover:text-accent-text disabled:opacity-50"
    >
      {pending ? "…" : "Restore"}
    </button>
  );
}
