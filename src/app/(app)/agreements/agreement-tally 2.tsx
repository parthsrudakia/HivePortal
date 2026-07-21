"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmModal } from "@/components/confirm-modal";
import { SearchableSelect } from "@/components/searchable-select";
import {
  assignToTenancy,
  clearRequests,
  dismissRequest,
  getRequestPdfUrl,
  resendRequest,
  undismissRequest,
} from "./actions";

export type SigningRequestRow = {
  id: string;
  status: "pending" | "signed" | "dismissed";
  tenantName: string;
  recipientEmail: string;
  propertyAddress: string;
  sentAt: string;
  expiresAt: string;
  signedAt: string | null;
  signatureKind: "drawn" | "typed" | null;
  assignedTenancyId: string | null;
};

export type AssignOption = {
  tenancyId: string;
  label: string;
  hasLease: boolean;
};

type Filter = "outstanding" | "signed" | "dismissed" | "all";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function isExpired(r: SigningRequestRow): boolean {
  return r.status === "pending" && new Date(r.expiresAt).getTime() < Date.now();
}

const pillClass = (active: boolean) =>
  `rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-wide transition ${
    active ? "bg-ink text-white" : "border border-stone bg-white text-ink hover:bg-warm"
  }`;

const actionBtn =
  "rounded-full border border-stone bg-white px-3 py-1 text-xs font-medium text-ink transition hover:bg-warm disabled:opacity-40";

export function AgreementTally({
  requests,
  assignOptions,
}: {
  requests: SigningRequestRow[];
  assignOptions: AssignOption[];
}) {
  const [filter, setFilter] = useState<Filter>("outstanding");
  const [busy, setBusy] = useState<string | null>(null);
  // Per-request assign picker selection and pending replace confirmation.
  const [assignPick, setAssignPick] = useState<Record<string, string>>({});
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);

  const counts = useMemo(() => {
    const outstanding = requests.filter((r) => r.status === "pending").length;
    const signed = requests.filter((r) => r.status === "signed").length;
    const dismissed = requests.filter((r) => r.status === "dismissed").length;
    return { outstanding, signed, dismissed };
  }, [requests]);

  const visible = requests.filter((r) => {
    if (filter === "all") return true;
    if (filter === "outstanding") return r.status === "pending";
    return r.status === filter;
  });

  const run = async (
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMsg: string,
  ) => {
    setBusy(id);
    try {
      const res = await fn();
      if (res.ok) toast.success(successMsg);
      else toast.error(res.error ?? "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const viewPdf = async (id: string) => {
    setBusy(id);
    try {
      const res = await getRequestPdfUrl(id);
      if (res.ok) window.open(res.url, "_blank", "noopener");
      else toast.error(res.error);
    } finally {
      setBusy(null);
    }
  };

  const assign = async (r: SigningRequestRow, replace: boolean) => {
    const tenancyId = assignPick[r.id];
    if (!tenancyId) {
      toast.error("Pick a tenant to assign the signed PDF to.");
      return;
    }
    setBusy(r.id);
    try {
      const res = await assignToTenancy(r.id, tenancyId, { replace });
      if (res.ok) {
        setConfirmReplace(null);
        toast.success("Signed agreement saved to the tenant's profile.");
      } else if (res.needsReplace) {
        setConfirmReplace(r.id);
      } else {
        toast.error(res.error ?? "Something went wrong.");
      }
    } finally {
      setBusy(null);
    }
  };

  const statusBadge = (r: SigningRequestRow) => {
    if (r.status === "signed") {
      return (
        <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent-text">
          Signed {r.signedAt ? fmtDate(r.signedAt) : ""}
        </span>
      );
    }
    if (r.status === "dismissed") {
      return (
        <span className="rounded-full bg-warm px-3 py-1 text-xs font-medium text-muted">
          Dismissed
        </span>
      );
    }
    if (isExpired(r)) {
      return (
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
          Link expired
        </span>
      );
    }
    return (
      <span className="rounded-full bg-warm px-3 py-1 text-xs font-medium text-ink">
        Awaiting signature · {daysSince(r.sentAt)}d
      </span>
    );
  };

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Signing tally
          </h2>
          <p className="mt-1 text-xs text-muted">
            Every agreement sent with a signing link, and who still owes you a
            signature.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setFilter("outstanding")}
            className={pillClass(filter === "outstanding")}
          >
            Outstanding ({counts.outstanding})
          </button>
          <button
            type="button"
            onClick={() => setFilter("signed")}
            className={pillClass(filter === "signed")}
          >
            Signed ({counts.signed})
          </button>
          <button
            type="button"
            onClick={() => setFilter("dismissed")}
            className={pillClass(filter === "dismissed")}
          >
            Dismissed ({counts.dismissed})
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={pillClass(filter === "all")}
          >
            All
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          {filter === "outstanding"
            ? "No one owes you a signature right now."
            : "Nothing here yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-stone/40">
          {visible.map((r) => (
            <li key={r.id} className="flex flex-col gap-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{r.tenantName}</p>
                  <p className="truncate text-xs text-muted">
                    {r.recipientEmail} · {r.propertyAddress} · sent{" "}
                    {fmtDate(r.sentAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(r)}
                  {r.status === "pending" && (
                    <>
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() =>
                          run(
                            r.id,
                            () => resendRequest(r.id),
                            "Agreement re-sent with a fresh 48-hour link.",
                          )
                        }
                        className={actionBtn}
                      >
                        {isExpired(r) ? "Renew & resend" : "Resend"}
                      </button>
                      <ConfirmModal
                        trigger={
                          <button type="button" disabled={busy === r.id} className={actionBtn}>
                            Dismiss
                          </button>
                        }
                        title="Dismiss this request?"
                        message={`${r.tenantName} will be removed from the outstanding tally. Their signing link stops working.`}
                        confirmLabel="Dismiss"
                        onConfirm={() =>
                          run(r.id, () => dismissRequest(r.id), "Removed from the tally.")
                        }
                      />
                    </>
                  )}
                  {r.status === "signed" && (
                    <>
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => viewPdf(r.id)}
                        className={actionBtn}
                      >
                        View PDF
                      </button>
                      <ConfirmModal
                        trigger={
                          <button type="button" disabled={busy === r.id} className={actionBtn}>
                            Dismiss
                          </button>
                        }
                        title="Dismiss this signed agreement?"
                        message={`${r.tenantName}'s signed agreement stays stored, but the entry leaves the tally.`}
                        confirmLabel="Dismiss"
                        onConfirm={() =>
                          run(r.id, () => dismissRequest(r.id), "Removed from the tally.")
                        }
                      />
                    </>
                  )}
                  {r.status === "dismissed" && (
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() =>
                        run(r.id, () => undismissRequest(r.id), "Back in the tally.")
                      }
                      className={actionBtn}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>

              {r.status === "signed" && !r.assignedTenancyId && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warm/60 p-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    Assign to tenant
                  </span>
                  <SearchableSelect
                    className="min-w-52 flex-1"
                    placeholder="Search tenants…"
                    value={assignPick[r.id] ?? ""}
                    onSelect={(id) => {
                      setAssignPick((prev) => ({ ...prev, [r.id]: id }));
                      setConfirmReplace(null);
                    }}
                    options={assignOptions.map((o) => ({
                      id: o.tenancyId,
                      label: `${o.label}${o.hasLease ? " (has a lease PDF)" : ""}`,
                    }))}
                  />
                  {confirmReplace === r.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-amber-800">
                        Already has a lease PDF — replace it?
                      </span>
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => assign(r, true)}
                        className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white transition hover:bg-accent-dark disabled:opacity-40"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmReplace(null)}
                        className="text-xs text-muted hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === r.id || !assignPick[r.id]}
                      onClick={() => assign(r, false)}
                      className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark disabled:opacity-40"
                    >
                      Assign
                    </button>
                  )}
                </div>
              )}
              {r.status === "signed" && r.assignedTenancyId && (
                <p className="text-xs text-muted">
                  ✓ Saved to the tenant&rsquo;s profile.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
