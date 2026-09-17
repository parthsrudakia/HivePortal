"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Site-wide "something is happening" signal. Every server action and every
 * client-side navigation/refresh the App Router makes goes through
 * `window.fetch` with a telltale header (`next-action` for actions, `rsc`
 * for route payloads — prefetches carry `next-router-prefetch` and are
 * ignored). Wrapping fetch once lets us count in-flight work without touching
 * any of the 100+ forms and buttons individually.
 *
 * Renders a thin honey progress bar along the top edge plus a small centred
 * pill ("Saving…" / "Loading…") once work has been running long enough to
 * notice. While a mutation is in flight, a reload/close prompts first so the
 * action can't be interrupted by accident.
 */

type Kind = "actions" | "navs";
/** `pill` flips on once work has run for PILL_DELAY_MS, so sub-second
 *  requests never flash the label. */
type Snapshot = Record<Kind, number> & { pill: boolean };

const PILL_DELAY_MS = 350;
let snapshot: Snapshot = { actions: 0, navs: 0, pill: false };
const SERVER_SNAPSHOT: Snapshot = { actions: 0, navs: 0, pill: false };
const listeners = new Set<() => void>();
let pillTimer: number | null = null;

function emit(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}
function bump(kind: Kind, delta: number) {
  const next = { ...snapshot, [kind]: Math.max(0, snapshot[kind] + delta) };
  const active = next.actions + next.navs > 0;
  if (active && pillTimer === null && !next.pill) {
    pillTimer = window.setTimeout(() => {
      pillTimer = null;
      emit({ ...snapshot, pill: true });
    }, PILL_DELAY_MS);
  } else if (!active) {
    if (pillTimer !== null) window.clearTimeout(pillTimer);
    pillTimer = null;
    next.pill = false;
  }
  emit(next);
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const getSnapshot = () => snapshot;
const getServerSnapshot = () => SERVER_SNAPSHOT;

function classify(input: RequestInfo | URL, init?: RequestInit): Kind | null {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (headers.has("next-action")) return "actions";
  if (headers.get("rsc") === "1" && !headers.has("next-router-prefetch")) {
    return "navs";
  }
  return null;
}

let installed = false;
function installFetchTracker() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch;
  window.fetch = function trackedFetch(input, init) {
    const kind = classify(input, init);
    if (!kind) return original.call(window, input, init);
    bump(kind, 1);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      bump(kind, -1);
    };
    return original.call(window, input, init).then(
      (res) => {
        // The promise resolves on headers, but an action's result and the
        // re-rendered tree arrive in the streamed body — stay "busy" until
        // the whole body has come through. Reading a clone leaves the
        // original stream untouched for the router.
        if (res.body) res.clone().arrayBuffer().then(finish, finish);
        else finish();
        return res;
      },
      (err) => {
        finish();
        throw err;
      },
    );
  };
}

export function ActivityIndicator() {
  const { actions, navs, pill } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const active = actions + navs > 0;
  const showPill = active && pill;

  useEffect(() => {
    installFetchTracker();
    const guard = (e: BeforeUnloadEvent) => {
      if (snapshot.actions === 0) return;
      e.preventDefault();
    };
    // Components often share one `pending` flag across several buttons
    // (approve / reject / delete…). Remember which button was clicked last so
    // the CSS spinner lands on that one only; the rest merely dim. Implicit
    // form submission (Enter in a field) fires a click on the submit button,
    // so it is covered too.
    const remember = (e: MouseEvent) => {
      const btn =
        e.target instanceof Element ? e.target.closest("button") : null;
      for (const prev of document.querySelectorAll(
        "button[data-activity-clicked]",
      )) {
        prev.removeAttribute("data-activity-clicked");
      }
      btn?.setAttribute("data-activity-clicked", "");
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", remember, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", remember, true);
    };
  }, []);

  const label = actions > 0 ? "Saving…" : "Loading…";

  return (
    <>
      {/* Top-edge progress bar: visible the instant work starts. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 overflow-hidden transition-opacity duration-200 ${
          active ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="activity-bar h-full w-full" />
      </div>

      {/* Centred pill: appears once work has run long enough to notice. */}
      <div
        role="status"
        aria-live="polite"
        aria-busy={active}
        className={`pointer-events-none fixed left-1/2 top-3 z-[70] -translate-x-1/2 transition-all duration-200 ${
          showPill ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 rounded-full border border-stone/60 bg-white px-3 py-1.5 text-xs font-medium text-ink shadow-md">
          <span className="activity-spinner" aria-hidden="true" />
          {active ? label : ""}
        </div>
      </div>
    </>
  );
}
