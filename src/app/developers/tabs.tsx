"use client";

import { useEffect, useState, type ReactNode } from "react";

type TabKey = "tenants" | "inventory";

/**
 * Pill-tab switcher for the API references. The active tab is mirrored into
 * the URL hash (#tenants / #inventory) so a specific API's docs can be
 * linked directly; the doc content itself stays server-rendered and is
 * passed in as props.
 */
export function DevelopersTabs({
  tenants,
  inventory,
}: {
  tenants: ReactNode;
  inventory: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("tenants");

  // Honor a #inventory deep link after mount (server render can't see the
  // hash, so the initial state must be deterministic to avoid a hydration
  // mismatch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync from the URL hash, which the server render cannot see
    if (window.location.hash === "#inventory") setTab("inventory");
  }, []);

  const select = (next: TabKey) => {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  };

  const pill = (key: TabKey, label: string) => (
    <button
      type="button"
      onClick={() => select(key)}
      aria-pressed={tab === key}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
        tab === key ? "bg-ink text-white shadow-sm" : "text-ink hover:bg-warm"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="mt-8 inline-flex gap-1 rounded-full bg-warm/60 p-1">
        {pill("tenants", "Tenants API")}
        {pill("inventory", "Inventory API")}
      </div>
      <div className={tab === "tenants" ? "" : "hidden"}>{tenants}</div>
      <div className={tab === "inventory" ? "" : "hidden"}>{inventory}</div>
    </>
  );
}
