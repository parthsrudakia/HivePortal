"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";

type Item = {
  id: string;
  kind: "property" | "tenant" | "room" | "page";
  label: string;
  sublabel?: string | null;
  href: string;
};

const STATIC_PAGES: Item[] = [
  { id: "p-dashboard", kind: "page", label: "Dashboard", href: "/" },
  { id: "p-properties", kind: "page", label: "Properties", href: "/properties" },
  { id: "p-inventory", kind: "page", label: "Inventory", href: "/inventory" },
  { id: "p-tenants", kind: "page", label: "Tenants & Rent", href: "/tenants" },
  { id: "p-reconciliation", kind: "page", label: "Reconciliation", href: "/reconciliation" },
  { id: "p-cleaning", kind: "page", label: "Cleaning", href: "/cleaning" },
  { id: "p-marketing", kind: "page", label: "Marketing", href: "/marketing" },
  { id: "p-credentials", kind: "page", label: "Credentials", href: "/credentials" },
  { id: "p-notifications", kind: "page", label: "Notifications", href: "/settings/notifications" },
];

const KIND_LABEL: Record<Item["kind"], string> = {
  page: "Page",
  property: "Property",
  tenant: "Tenant",
  room: "Room",
};

function score(item: Item, q: string): number {
  if (!q) return 1;
  const hay = `${item.label} ${item.sublabel ?? ""}`.toLowerCase();
  const needle = q.toLowerCase();
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 50;
  if (hay.includes(needle)) return 20;
  // Token match: every word in needle appears somewhere.
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((t) => hay.includes(t))) return 5;
  return 0;
}

export function CommandPalette() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [dynamic, setDynamic] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  // Hotkey: Cmd-K / Ctrl-K toggles. Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Fetch the searchable index lazily on first open.
  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const [{ data: properties }, { data: tenants }, { data: rooms }] =
        await Promise.all([
          supabase
            .from("properties")
            .select("id, building_name, street_address, unit_number, neighborhood"),
          supabase.from("tenants").select("id, full_name, email"),
          supabase
            .from("rooms")
            .select("id, room_number, properties(building_name, street_address, unit_number)"),
        ]);

      const propItems: Item[] = (properties ?? []).map((p) => ({
        id: `prop-${p.id}`,
        kind: "property",
        label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
        sublabel: p.neighborhood ?? null,
        href: `/properties/${p.id}`,
      }));
      const tenantItems: Item[] = (tenants ?? []).map((t) => ({
        id: `tenant-${t.id}`,
        kind: "tenant",
        label: t.full_name,
        sublabel: t.email ?? null,
        href: `/tenants/${t.id}`,
      }));
      type RoomRow = {
        id: string;
        room_number: string | null;
        properties:
          | { building_name: string | null; street_address: string; unit_number: string }
          | { building_name: string | null; street_address: string; unit_number: string }[]
          | null;
      };
      const roomItems: Item[] = ((rooms ?? []) as RoomRow[]).map((r) => {
        const p = Array.isArray(r.properties) ? r.properties[0] : r.properties;
        const unit = p
          ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
          : "—";
        return {
          id: `room-${r.id}`,
          kind: "room",
          label: `${unit} · ${r.room_number ?? "Room"}`,
          sublabel: null,
          href: `/inventory/${r.id}`,
        };
      });
      setDynamic([...propItems, ...tenantItems, ...roomItems]);
      setLoaded(true);
    })();
  }, [open, loaded, supabase]);

  useEffect(() => {
    if (open) queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const all = useMemo(() => [...STATIC_PAGES, ...dynamic], [dynamic]);
  const results = useMemo(() => {
    if (!query.trim()) return all.slice(0, 30);
    return all
      .map((it) => ({ it, s: score(it, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.it);
  }, [all, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  function go(item: Item) {
    setOpen(false);
    setQuery("");
    router.push(item.href);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIdx];
      if (item) go(item);
    }
  }

  if (!mounted || !open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
    >
      <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-stone/40 px-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search tenants, properties, rooms…"
            className="flex-1 bg-transparent py-3 text-sm text-ink placeholder:text-muted focus:outline-none"
          />
          <kbd className="rounded border border-stone/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
            Esc
          </kbd>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-2">
          {!loaded && (
            <li className="px-4 py-3 text-xs text-muted">Loading…</li>
          )}
          {loaded && results.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted">
              No matches for &ldquo;{query}&rdquo;.
            </li>
          )}
          {results.map((item, i) => {
            const active = i === activeIdx;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => go(item)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left ${
                    active ? "bg-warm" : "bg-white"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{item.label}</p>
                    {item.sublabel && (
                      <p className="truncate text-[11px] text-muted">{item.sublabel}</p>
                    )}
                  </div>
                  <span className="text-[10px] uppercase tracking-wide text-muted">
                    {KIND_LABEL[item.kind]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-stone/40 px-4 py-2 text-[11px] text-muted">
          <kbd className="rounded border border-stone/60 px-1">↑↓</kbd>{" "}
          navigate&nbsp;·&nbsp;
          <kbd className="rounded border border-stone/60 px-1">⏎</kbd> open
          &nbsp;·&nbsp;
          <kbd className="rounded border border-stone/60 px-1">⌘K</kbd> toggle
        </div>
      </div>
    </div>,
    document.body,
  );
}
