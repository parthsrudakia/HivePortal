"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addRoomAd,
  deleteRoomAd,
  setRoomAvailableFrom,
  setRoomBaseRent,
  setRoomFacebookAds,
  setRoomPhotosUrl,
  setRoomServicesFee,
} from "./actions";
import type { AdRow } from "./constants";

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString()}`;
}

function fmtDate(s: string | null) {
  if (!s) return "—";
  const ten = s.slice(0, 10);
  const [y, m, d] = ten.split("-");
  if (!y || !m || !d) return s;
  return `${m}/${d}/${y.slice(2)}`;
}

const cellButton =
  "w-full rounded px-1.5 py-0.5 text-center hover:bg-warm/60 focus:outline-none focus:ring-1 focus:ring-accent";

function MoneyCellEditor({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (n: number) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`${cellButton} tabular-nums text-ink ${pending ? "opacity-60" : ""}`}
      >
        {fmtMoney(value)}
      </button>
    );
  }

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      await onCommit(n);
      setEditing(false);
    });
  };

  return (
    <input
      type="number"
      min={0}
      step={1}
      autoFocus
      defaultValue={value ?? ""}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      className="w-20 rounded border border-accent bg-white px-1.5 py-0.5 text-center tabular-nums text-ink focus:outline-none"
    />
  );
}

export function InlineBaseRentEdit({
  roomId,
  value,
}: {
  roomId: string;
  value: number | null;
}) {
  return (
    <MoneyCellEditor
      value={value}
      onCommit={async (n) => {
        await setRoomBaseRent(roomId, n);
      }}
    />
  );
}

export function InlineServicesEdit({
  roomId,
  value,
}: {
  roomId: string;
  value: number | null;
}) {
  return (
    <MoneyCellEditor
      value={value}
      onCommit={async (n) => {
        await setRoomServicesFee(roomId, n);
      }}
    />
  );
}

export function InlinePhotosEdit({
  roomId,
  url,
}: {
  roomId: string;
  url: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  const commit = (value: string) => {
    startTransition(async () => {
      const res = await setRoomPhotosUrl(roomId, value.trim() || null);
      if ("error" in res) {
        toast.error(`Couldn't save photos link: ${res.error}`);
        return; // keep editing so the value isn't lost
      }
      setEditing(false);
    });
  };

  if (editing) {
    return (
      <input
        type="url"
        autoFocus
        defaultValue={url ?? ""}
        placeholder="https://drive.google.com/…"
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="w-48 rounded border border-accent bg-white px-1.5 py-0.5 text-xs text-ink focus:outline-none"
      />
    );
  }

  return (
    <div className={`flex items-center justify-center gap-1.5 ${pending ? "opacity-60" : ""}`}>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-purple-700 underline hover:text-purple-900"
        >
          Open
        </a>
      ) : null}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-full px-2 py-0.5 text-xs uppercase tracking-wide text-accent-text hover:bg-warm"
      >
        {url ? "Edit" : "+ Add"}
      </button>
    </div>
  );
}

// A room can hold several ads, each posted by a different person. List every
// ad as an "Open" link with its poster, allow removing any, and add a new one
// inline — each addition is recorded under the current user.
export function InlineAdEdit({
  roomId,
  ads,
}: {
  roomId: string;
  ads: AdRow[];
}) {
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  const add = (value: string) => {
    const url = value.trim();
    startTransition(async () => {
      if (url) {
        const res = await addRoomAd(roomId, url);
        if (res?.error) {
          toast.error(`Couldn't add ad: ${res.error}`);
          return; // keep the input open so the URL isn't lost
        }
      }
      setAdding(false);
    });
  };

  const remove = (adId: string) => {
    startTransition(async () => {
      const res = await deleteRoomAd(adId, roomId);
      if ("error" in res) toast.error(`Couldn't remove ad: ${res.error}`);
    });
  };

  return (
    // Horizontal so a row with ads stays the standard height; the poster's
    // name lives in the adjacent "Ad Posted" column (and each link's tooltip).
    <div
      className={`flex items-center justify-center gap-2 ${pending ? "opacity-60" : ""}`}
    >
      {ads.map((ad, i) => (
        <span key={ad.id} className="flex items-center gap-0.5 whitespace-nowrap">
          <a
            href={ad.url}
            target="_blank"
            rel="noopener noreferrer"
            title={ad.posted_by?.trim() || undefined}
            className="text-xs text-purple-700 underline hover:text-purple-900"
          >
            {ads.length === 1 ? "Open" : `Ad ${i + 1}`}
          </a>
          <button
            type="button"
            onClick={() => remove(ad.id)}
            aria-label="Remove ad"
            title="Remove ad"
            className="rounded-full px-1 text-xs leading-none text-muted hover:bg-warm hover:text-red-700"
          >
            ×
          </button>
        </span>
      ))}

      {adding ? (
        <input
          type="url"
          autoFocus
          placeholder="https://…"
          onBlur={(e) => add(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(e.currentTarget.value);
            } else if (e.key === "Escape") {
              setAdding(false);
            }
          }}
          className="w-48 rounded border border-accent bg-white px-1.5 py-0.5 text-xs text-ink focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-full px-2 py-0.5 text-xs uppercase tracking-wide text-accent-text hover:bg-warm"
        >
          Add
        </button>
      )}
    </div>
  );
}

// On/off pill for the "Facebook ads running?" flag on a listing.
export function InlineFacebookAdsToggle({
  roomId,
  on,
}: {
  roomId: string;
  on: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    startTransition(async () => {
      const res = await setRoomFacebookAds(roomId, !on);
      if ("error" in res)
        toast.error(`Couldn't update Facebook ads: ${res.error}`);
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={on}
      aria-label="Facebook ads"
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
        on
          ? "border-accent bg-accent/15 text-accent-text hover:border-accent-dark"
          : "border-stone bg-cream/60 text-muted hover:border-accent hover:text-ink"
      } ${pending ? "opacity-60" : ""}`}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

export function InlineDateEdit({
  roomId,
  date,
}: {
  roomId: string;
  date: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`${cellButton} tabular-nums text-ink ${pending ? "opacity-60" : ""}`}
      >
        {fmtDate(date)}
      </button>
    );
  }

  const commit = (value: string) => {
    startTransition(async () => {
      await setRoomAvailableFrom(roomId, value || null);
      setEditing(false);
    });
  };

  return (
    <input
      type="date"
      autoFocus
      defaultValue={date?.slice(0, 10) ?? ""}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      className="w-36 rounded border border-accent bg-white px-1.5 py-0.5 text-center tabular-nums text-ink focus:outline-none"
    />
  );
}
