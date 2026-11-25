"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cancelApplicationInvite, createApplicationInvite } from "./actions";

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

export type InviteUnitOption = {
  id: string;
  label: string;
  isNewYork: boolean;
  rooms: { id: string; label: string; rent: number | null }[];
};

export type InviteRow = {
  id: string;
  url: string;
  status: "sent" | "used" | "expired" | "cancelled";
  /** Being completed by the website right now. */
  completing: boolean;
  applicantEmail: string;
  applicantName: string | null;
  place: string;
  rent: string;
  deposit: string;
  sentOn: string;
  expiresOn: string;
  usedOn: string | null;
  tenantName: string | null;
  tenantEmail: string | null;
  emailDiffers: boolean;
  depositEmailSent: boolean;
};

const NY_MESSAGE =
  "New York units: send the agreement from the Agreements page as usual.";

function money(n: number | null): string {
  if (n == null) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied.");
  } catch {
    toast.error("Couldn't copy. Select the link and copy it by hand.");
  }
}

export function ApplicationInvites({
  units,
  invites,
}: {
  units: InviteUnitOption[];
  invites: InviteRow[];
}) {
  const [unitId, setUnitId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [rent, setRent] = useState("");
  const [deposit, setDeposit] = useState("");
  const [sending, setSending] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const unit = useMemo(() => units.find((u) => u.id === unitId) ?? null, [units, unitId]);
  const open = invites.filter((i) => i.status === "sent");
  const closed = invites.filter((i) => i.status !== "sent");

  const pickUnit = (id: string) => {
    setUnitId(id);
    setRoomId("");
    setRent("");
    setDeposit("");
  };
  // Rent defaults to the room's total rent and the deposit to one month's
  // rent; both stay editable here (never by the applicant).
  const pickRoom = (id: string) => {
    setRoomId(id);
    const room = unit?.rooms.find((r) => r.id === id);
    setRent(money(room?.rent ?? null));
    setDeposit(money(room?.rent ?? null));
  };

  const send = async () => {
    if (!unit || !roomId) {
      toast.error("Pick a unit and a room.");
      return;
    }
    setSending(true);
    try {
      const res = await createApplicationInvite({
        propertyId: unit.id,
        roomId,
        applicantEmail: email,
        applicantName: name,
        rent,
        securityDeposit: deposit,
      });
      if (res.ok && res.url) {
        toast.success(`Application link sent to ${email.trim()}.`);
        setLastUrl(res.url);
        setEmail("");
        setName("");
      } else {
        toast.error(res.error ?? "Couldn't send the link.");
      }
    } finally {
      setSending(false);
    }
  };

  const cancel = async (id: string) => {
    if (!window.confirm("Cancel this application link? The applicant won't be able to use it.")) return;
    setCancelling(id);
    try {
      const res = await cancelApplicationInvite(id);
      if (res.ok) toast.success("Link cancelled.");
      else toast.error(res.error ?? "Couldn't cancel the link.");
    } finally {
      setCancelling(null);
    }
  };

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        Send application link
      </h2>
      <p className="mt-1 text-xs text-muted">
        The applicant applies on hiveny.com (details, dates, photo ID, fee).
        Once they pay, the agreement goes to this email with the rent and
        deposit set here. Links work for 14 days.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Unit *</span>
          <select value={unitId} onChange={(e) => pickUnit(e.target.value)} className={fieldInput}>
            <option value="">Pick a unit</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
                {u.isNewYork ? " (New York)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Room *</span>
          <select
            value={roomId}
            onChange={(e) => pickRoom(e.target.value)}
            disabled={!unit || unit.isNewYork}
            className={fieldInput}
          >
            <option value="">{unit ? "Pick a room" : "Pick a unit first"}</option>
            {(unit?.rooms ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.rent != null ? ` · $${r.rent.toLocaleString("en-US")}` : ""}
              </option>
            ))}
          </select>
        </label>
        {unit?.isNewYork && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:col-span-2">
            {NY_MESSAGE}
          </p>
        )}
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Applicant email *</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="applicant@example.com"
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Applicant name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Monthly rent *</span>
          <input
            type="text"
            inputMode="decimal"
            value={rent}
            onChange={(e) => setRent(e.target.value)}
            className={fieldInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Security deposit *</span>
          <input
            type="text"
            inputMode="decimal"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            className={fieldInput}
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={sending || !unit || unit.isNewYork || !roomId || !email.trim()}
          aria-busy={sending}
          className="rounded-full bg-accent px-5 py-2 text-xs font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send application link"}
        </button>
        {lastUrl && (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <span className="truncate">{lastUrl}</span>
            <button
              type="button"
              onClick={() => copy(lastUrl)}
              className="shrink-0 font-semibold uppercase tracking-wider text-accent-text hover:text-accent-dark"
            >
              Copy link
            </button>
          </span>
        )}
      </div>

      <h3 className="mt-8 text-xs font-medium uppercase tracking-wide text-muted">
        Open links ({open.length})
      </h3>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No open application links.</p>
      ) : (
        <ul className="mt-2 divide-y divide-warm">
          {open.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="text-ink">
                  {i.applicantName ? `${i.applicantName} · ` : ""}
                  {i.applicantEmail}
                </p>
                <p className="text-xs text-muted">
                  {i.place} · {i.rent}/mo · deposit {i.deposit} · sent {i.sentOn} · expires {i.expiresOn}
                  {i.completing ? " · applying now" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <button
                  type="button"
                  onClick={() => copy(i.url)}
                  className="text-xs font-semibold uppercase tracking-wider text-accent-text hover:text-accent-dark"
                >
                  Copy link
                </button>
                <button
                  type="button"
                  onClick={() => cancel(i.id)}
                  disabled={cancelling === i.id || i.completing}
                  className="text-xs text-muted hover:text-ink disabled:opacity-40"
                >
                  {cancelling === i.id ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <>
          <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-muted">
            Recent (last 30 days)
          </h3>
          <ul className="mt-2 divide-y divide-warm">
            {closed.map((i) => (
              <li key={i.id} className="py-3 text-sm">
                <p className="text-ink">
                  {i.tenantName ?? i.applicantName ?? i.applicantEmail}
                  <span className="ml-2 rounded-full bg-warm px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    {i.status === "used" ? "applied" : i.status}
                  </span>
                  {i.emailDiffers && (
                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-800">
                      Email differs from invite
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {i.place} · {i.rent}/mo · deposit {i.deposit}
                  {i.status === "used"
                    ? ` · applied ${i.usedOn ?? ""} · agreement sent to ${i.applicantEmail}` +
                      (i.emailDiffers && i.tenantEmail ? ` (they typed ${i.tenantEmail})` : "") +
                      (i.depositEmailSent ? " · deposit email sent" : "")
                    : ` · invited ${i.applicantEmail} on ${i.sentOn}`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
