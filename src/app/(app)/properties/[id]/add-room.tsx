"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addRoom, type RoomFormState } from "./room-actions";
import { RoomFields } from "./room-fields";

export function AddRoom({
  propertyId,
  suggestedRoomNumber,
}: {
  propertyId: string;
  suggestedRoomNumber: string;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const boundAction = addRoom.bind(null, propertyId) as (
    state: RoomFormState,
    formData: FormData,
  ) => Promise<RoomFormState>;

  const [state, action, pending] = useActionState<RoomFormState, FormData>(
    boundAction,
    undefined,
  );

  useEffect(() => {
    if (state === undefined) {
      formRef.current?.reset();
    }
  }, [state]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark"
      >
        Add room
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="rounded-2xl bg-white p-6 shadow-sm"
    >
      <p className="text-xs uppercase tracking-wide text-muted">New room</p>
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Which room? *
        </span>
        <input
          type="text"
          name="room_number"
          required
          defaultValue={suggestedRoomNumber}
          placeholder="e.g. Room 3 or 2B"
          className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none sm:max-w-xs"
        />
      </label>
      <p className="mt-1.5 text-xs text-muted">
        New rooms are always created as <em>Available</em> — you can change the
        status later by editing the room.
      </p>
      <div className="mt-4">
        <RoomFields showStatus={false} />
      </div>
      {state?.error && (
        <p className="mt-3 text-sm text-red-700">{state.error}</p>
      )}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save room"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs uppercase tracking-wide text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
