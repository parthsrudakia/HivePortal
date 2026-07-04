"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  updateRoom,
  deleteRoom,
  type RoomFormState,
} from "./room-actions";
import { RoomFields } from "./room-fields";
import { formatDate } from "@/lib/date";

type Room = {
  id: string;
  room_number: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  available_from: string | null;
  has_private_bathroom: boolean;
  notes: string | null;
  marketing_description: string | null;
  photos_url: string | null;
};

const STATUS_STYLES: Record<Room["status"], string> = {
  available: "bg-accent/15 text-accent-text",
  occupied: "bg-warm text-ink/70",
  reserved: "bg-stone/40 text-ink/70",
  maintenance: "bg-red-100 text-red-800",
};

function fmtMoney(n: number | null) {
  if (n === null) return "—";
  return `$${n.toLocaleString()}`;
}

export function RoomRow({
  propertyId,
  room,
}: {
  propertyId: string;
  room: Room;
}) {
  const [editing, setEditing] = useState(false);

  const boundUpdate = updateRoom.bind(null, propertyId, room.id) as (
    state: RoomFormState,
    formData: FormData,
  ) => Promise<RoomFormState>;

  const [state, editAction, pending] = useActionState<RoomFormState, FormData>(
    boundUpdate,
    undefined,
  );

  if (editing) {
    return (
      <li className="rounded-2xl bg-white p-5 shadow-sm">
        <form
          action={async (fd) => {
            const result = await editAction(fd);
            if (result === undefined) setEditing(false);
            return result;
          }}
        >
          <p className="text-xs uppercase tracking-wide text-muted">
            Editing {room.room_number ?? "room"}
          </p>
          <div className="mt-3">
            <RoomFields initial={room} />
          </div>
          {state?.error && (
            <p className="mt-3 text-sm text-red-700">{state.error}</p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs uppercase tracking-wide text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base text-ink">{room.room_number ?? "—"}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-xs uppercase tracking-wide ${STATUS_STYLES[room.status]}`}
            >
              {room.status}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>Total: {fmtMoney(room.total_rent)}</span>
            <span>Base: {fmtMoney(room.base_rent)}</span>
            <span>Services: {fmtMoney(room.bundle_fee)}</span>
            {room.available_from && (
              <span>Available {formatDate(room.available_from)}</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span
              className={
                room.has_private_bathroom
                  ? "text-ink"
                  : "text-muted line-through"
              }
            >
              Private bath
            </span>
          </div>
          {room.notes && (
            <p className="mt-2 text-xs text-muted">{room.notes}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {room.status !== "occupied" && (
            <Link
              href={`/tenants/new?room_id=${room.id}#add-tenant`}
              className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
            >
              Add tenant
            </Link>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
          >
            Edit
          </button>
          <form action={deleteRoom}>
            <input type="hidden" name="room_id" value={room.id} />
            <input type="hidden" name="property_id" value={propertyId} />
            <button
              type="submit"
              onClick={(e) => {
                if (
                  !confirm(
                    `Delete room "${room.room_number ?? room.id}"? This cannot be undone.`,
                  )
                ) {
                  e.preventDefault();
                }
              }}
              className="text-xs uppercase tracking-wide text-muted hover:text-red-700"
            >
              Delete
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}
