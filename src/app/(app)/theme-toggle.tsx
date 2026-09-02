"use client";

import { useEffect, useState } from "react";

/**
 * Dark-mode toggle for the sidebar. The theme is applied pre-paint by the
 * inline script in the root layout (reads localStorage, falls back to the OS
 * preference); this just flips the `dark` class on <html> and persists the
 * choice. Mirrors the nav-item styling so it sits naturally at the sidebar
 * bottom.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  // Read the actual applied theme after mount (the script may have set it from
  // the OS preference with nothing in localStorage yet).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the class the pre-paint script already applied
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // ignore — persistence is best-effort
    }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      data-label={dark ? "Light mode" : "Dark mode"}
      className="sidebar-item flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink transition hover:bg-warm"
    >
      {dark ? (
        // Sun — switch to light
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-accent"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // Moon — switch to dark
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-accent"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
      <span className="sidebar-label min-w-0 truncate">
        {dark ? "Light mode" : "Dark mode"}
      </span>
    </button>
  );
}
