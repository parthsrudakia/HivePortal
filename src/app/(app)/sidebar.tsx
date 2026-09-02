"use client";

import { useEffect, useState } from "react";

/**
 * Resizable desktop sidebar shell. Drag the right edge to resize; dragging
 * narrower than the label threshold snaps to an icon-only rail (labels and
 * badges hide via the `aside[data-collapsed]` rules in globals.css).
 * Double-click the edge to reset. Width persists per browser.
 */
const DEFAULT_W = 256; // the old fixed w-64
const MIN_W = 64; // icon-only rail
const MAX_W = 384;
// Below this the labels no longer fit — snap to the icon rail.
const COLLAPSE_AT = 168;
const STORAGE_KEY = "sidebar-width";

function clamp(w: number) {
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

export function Sidebar({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(DEFAULT_W);
  const [dragging, setDragging] = useState(false);

  const collapsed = width < COLLAPSE_AT;
  const effective = collapsed ? MIN_W : width;

  // Restore the saved width after mount (SSR renders the default).
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W)
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the persisted width
        setWidth(saved);
    } catch {
      // storage unavailable — keep the default
    }
  }, []);

  const persist = (w: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(w));
    } catch {
      // best-effort
    }
  };

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = effective;
    setDragging(true);

    let latest = width;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(startW + (ev.clientX - startX));
      setWidth(latest);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      setDragging(false);
      persist(latest < COLLAPSE_AT ? MIN_W : latest);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp, { once: true });
  };

  const reset = () => {
    setWidth(DEFAULT_W);
    persist(DEFAULT_W);
  };

  return (
    <aside
      data-collapsed={collapsed ? "" : undefined}
      style={{ width: effective }}
      className={`sticky top-0 hidden h-screen shrink-0 flex-col self-start overflow-hidden border-r border-stone/60 bg-white/60 px-4 py-8 md:flex ${
        dragging ? "" : "transition-[width,padding] duration-150"
      }`}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (double-click to reset)"
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={reset}
        className={`absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none transition hover:bg-accent/50 ${
          dragging ? "bg-accent/60" : ""
        }`}
      />
    </aside>
  );
}
