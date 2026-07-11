"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { recordManualPayments } from "./actions";

export type BulkTenant = {
  tenancy_id: string;
  name: string;
  unit: string;
  room: string | null;
  monthly_rent: number;
  paid_this_month: number;
};

export function BulkPaymentForm({
  tenants,
  defaultDate,
  admin = false,
}: {
  tenants: BulkTenant[];
  defaultDate: string;
  // Only admins see the "paid this month" figure; everyone else just records.
  admin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate);
  const [query, setQuery] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const filled = Object.values(amounts).filter((v) => v.trim() !== "").length;

  // Only show tenants the user searched for, plus any with an amount already
  // entered — never the full roster by default.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tenants.filter((t) => {
      if ((amounts[t.tenancy_id] ?? "").trim() !== "") return true;
      if (!q) return false;
      return (
        t.name.toLowerCase().includes(q) || t.unit.toLowerCase().includes(q)
      );
    });
  }, [tenants, query, amounts]);

  function submit() {
    const fd = new FormData();
    fd.set("paid_on", date);
    for (const [id, amt] of Object.entries(amounts)) {
      if (amt.trim() !== "") fd.set(`amount:${id}`, amt.trim());
    }
    startTransition(async () => {
      const res = await recordManualPayments(undefined, fd);
      if (res?.error) {
        toast.error(res.error);
      } else {
        toast.success(res?.success ?? "Payments recorded");
        setAmounts({}); // clear after a successful save
      }
    });
  }

  const fmtMoney = (n: number) => `$${n.toLocaleString()}`;

  return (
    <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Record payments
          </h2>
          <p className="mt-1 text-xs text-muted">
            Log rent payments for several tenants at once (cash, Zelle, etc.).
          </p>
        </div>
        <span className="text-xs uppercase tracking-wide text-accent-text">
          {open ? "Hide" : "Open"}
        </span>
      </button>

      {open && (
        <div className="mt-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Payment date
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5 sm:max-w-xs">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Search
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by tenant or unit…"
                className="rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-4 max-h-96 divide-y divide-stone/30 overflow-y-auto rounded-lg border border-stone/40">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted">
                {query.trim() === ""
                  ? "Search for a tenant to record a payment."
                  : "No tenants match."}
              </p>
            ) : (
              filtered.map((t) => (
                <div
                  key={t.tenancy_id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{t.name}</p>
                    <p className="truncate text-xs text-muted">
                      {t.unit}
                      {t.room ? ` · ${t.room}` : ""} · rent{" "}
                      {fmtMoney(t.monthly_rent)}
                      {admin && t.paid_this_month > 0
                        ? ` · paid ${fmtMoney(t.paid_this_month)} this month`
                        : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setAmounts((a) => ({
                        ...a,
                        [t.tenancy_id]: String(t.monthly_rent),
                      }))
                    }
                    className="shrink-0 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide text-accent-text hover:bg-warm"
                    title="Fill with monthly rent"
                  >
                    Rent
                  </button>
                  <div className="relative shrink-0">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted">
                      $
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={amounts[t.tenancy_id] ?? ""}
                      onChange={(e) =>
                        setAmounts((a) => ({
                          ...a,
                          [t.tenancy_id]: e.target.value,
                        }))
                      }
                      placeholder="0"
                      className="w-28 rounded-lg border border-stone bg-white py-1.5 pl-5 pr-2 text-right text-sm tabular-nums text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-4">
            <button
              type="button"
              onClick={submit}
              disabled={pending || filled === 0}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
            >
              {pending
                ? "Recording…"
                : `Record ${filled} payment${filled === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
