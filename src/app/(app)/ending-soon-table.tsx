"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDate } from "@/lib/date";

export type EndingSoonRow = {
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  unit: string;
  room: string;
  lease_end_date: string;
};

const PREVIEW = 12;

/**
 * Lease-ending-soon list. Shows the first {PREVIEW} rows; "+N more" expands
 * the card in place to show the rest (rather than navigating away), and
 * "Show less" collapses it again.
 */
export function EndingSoonTable({ rows }: { rows: EndingSoonRow[] }) {
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted">
        No moves planned in the next 30 days.
      </p>
    );
  }

  const visible = expanded ? rows : rows.slice(0, PREVIEW);

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-center text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-stone/40">
            <th className="px-3 py-2 text-left font-medium">Unit</th>
            <th className="px-3 py-2 font-medium">Room</th>
            <th className="px-3 py-2 font-medium">Tenant</th>
            <th className="px-3 py-2 font-medium">Lease end</th>
            <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Phone</th>
          </tr>
        </thead>
        <tbody className="text-center">
          {visible.map((t, i) => (
            <tr
              key={`${t.tenant_id}-${i}`}
              className="border-b border-stone/20 last:border-0 hover:bg-warm/30"
            >
              <td className="px-3 py-2 text-left">
                <Link
                  href={`/tenants/${t.tenant_id}`}
                  className="text-accent-text hover:text-accent-dark"
                >
                  {t.unit}
                </Link>
              </td>
              <td className="px-3 py-2 text-ink">{t.room || "—"}</td>
              <td className="px-3 py-2">
                <Link
                  href={`/tenants/${t.tenant_id}`}
                  className="text-accent-text hover:text-accent-dark"
                >
                  {t.name}
                </Link>
              </td>
              <td className="px-3 py-2 text-ink">
                {formatDate(t.lease_end_date)}
              </td>
              <td className="px-3 py-2">
                {t.email ? (
                  <a
                    href={`mailto:${t.email}`}
                    className="text-accent-text hover:text-accent-dark"
                  >
                    {t.email}
                  </a>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                {t.phone ? (
                  <a
                    href={`tel:${t.phone}`}
                    className="text-accent-text hover:text-accent-dark"
                  >
                    {t.phone}
                  </a>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 px-3 text-xs uppercase tracking-wide text-accent-text hover:text-accent-dark"
        >
          {expanded ? "Show less" : `+${rows.length - PREVIEW} more`}
        </button>
      )}
    </div>
  );
}
