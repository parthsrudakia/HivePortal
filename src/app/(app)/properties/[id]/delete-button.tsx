"use client";

import { toast } from "sonner";
import { deleteProperty } from "../actions";
import { ConfirmModal } from "@/components/confirm-modal";

type Props = { id: string; label: string };

export function DeletePropertyButton({ id, label }: Props) {
  return (
    <ConfirmModal
      title="Delete this property?"
      message={
        <>
          <strong>{label}</strong> and every room, tenancy, and payment record
          inside it will be permanently removed. This cannot be undone.
        </>
      }
      confirmLabel="Yes, delete"
      destructive
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("id", id);
        try {
          await deleteProperty(fd);
        } catch (e) {
          toast.error(
            e instanceof Error ? e.message : "Failed to delete property",
          );
        }
      }}
      trigger={
        <button
          type="button"
          className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
        >
          Delete this property
        </button>
      }
    />
  );
}
