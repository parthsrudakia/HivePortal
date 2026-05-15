"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

export function MobileNav({
  items,
  userEmail,
}: {
  items: NavItem[];
  userEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-stone/60 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
        <Link href="/" className="flex items-center gap-2 text-lg tracking-tight text-ink">
          <svg
            width="20"
            height="25"
            viewBox="0 0 80 100"
            xmlns="http://www.w3.org/2000/svg"
            className="text-accent"
            aria-hidden="true"
          >
            <circle cx="40" cy="8" r="4.5" fill="currentColor" />
            <rect x="28" y="18" width="24" height="6" rx="3" fill="currentColor" />
            <rect x="18" y="32" width="44" height="6" rx="3" fill="currentColor" />
            <rect x="15" y="46" width="50" height="6" rx="3" fill="currentColor" />
            <rect x="18" y="60" width="44" height="6" rx="3" fill="currentColor" />
            <rect x="28" y="74" width="24" height="6" rx="3" fill="currentColor" />
            <circle cx="40" cy="88" r="4" fill="currentColor" />
          </svg>
          <span>
            Hive <span className="font-display text-accent-text">Portal</span>
          </span>
        </Link>
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 text-ink hover:bg-warm"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute right-0 top-0 flex h-full w-72 flex-col bg-white px-4 py-6 shadow-xl">
            <div className="flex items-center justify-between px-2">
              <Link href="/" className="text-lg tracking-tight text-ink">
                Hive <span className="font-display text-accent-text">Portal</span>
              </Link>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-ink hover:bg-warm"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <nav className="mt-8 flex flex-col gap-1 text-sm">
              {items.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-lg px-3 py-2 transition ${
                      active
                        ? "bg-warm text-ink"
                        : "text-ink/80 hover:bg-warm hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            {userEmail && (
              <div className="mt-auto px-3 pt-6 text-xs text-muted">
                <p className="truncate">{userEmail}</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
