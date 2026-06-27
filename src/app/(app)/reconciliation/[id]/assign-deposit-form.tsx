"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { assignUnmatchedDeposit } from "../actions";

export type AssignTenantOption = { tenancyId: string; label: string };

function fmtMoney(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDate(s: string | null | undefined) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : s;
}

/** One unmatched deposit with an inline "assign to tenant" control. Assigning
 *  records the bank's payer name as that tenant's pays_as so it matches now and
 *  on every future statement. */
export function AssignDepositForm({
  runId,
  payerKey,
  label,
  amount,
  date,
  tenants,
}: {
  runId: string;
  payerKey: string;
  label: string;
  amount: number;
  date: string | null;
  tenants: AssignTenantOption[];
}) {
  const [tenancyId, setTenancyId] = useState("");
  const [pending, startTransition] = useTransition();

  function assign() {
    if (!tenancyId) {
      toast.error("Pick a tenant to assign this deposit to.");
      return;
    }
    const fd = new FormData();
    fd.set("run_id", runId);
    fd.set("payer_key", payerKey);
    fd.set("tenancy_id", tenancyId);
    startTransition(async () => {
      const res = await assignUnmatchedDeposit(undefined, fd);
      if (res?.error) toast.error(res.error);
      else toast.success(res?.success ?? "Assigned.");
    });
  }

  const dateLabel = fmtDate(date);

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg bg-cream/60 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ink">{label}</p>
        {dateLabel && <p className="text-xs text-muted">{dateLabel}</p>}
      </div>
      <span className="shrink-0 font-medium text-ink tabular-nums">
        {fmtMoney(amount)}
      </span>
      <select
        value={tenancyId}
        onChange={(e) => setTenancyId(e.target.value)}
        disabled={pending}
        className="max-w-[14rem] shrink-0 rounded-lg border border-stone bg-white px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
      >
        <option value="">Assign to…</option>
        {tenants.map((t) => (
          <option key={t.tenancyId} value={t.tenancyId}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={assign}
        disabled={pending || !tenancyId}
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-accent-dark disabled:opacity-50"
      >
        {pending ? "Assigning…" : "Assign"}
      </button>
    </li>
  );
}
