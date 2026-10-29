"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  buildAgreementPdf,
  agreementFilename,
} from "@/lib/agreement-pdf";
import { sendAgreementToTenant } from "./actions";

export type TenancyPrefill = {
  id: string;
  label: string;
  tenantName: string;
  tenantEmail: string;
  propertyId: string;
  propertyAddress: string;
  roomId: string;
  roomNumber: string;
  rent: string;
  securityDeposit: string;
  leaseStartDate: string;
  leaseEndDate: string;
  isNewYork: boolean;
};

/** A unit already in the portal — the only addresses an agreement can use. */
export type PropertyOption = {
  id: string;
  label: string;
  address: string;
  isNewYork: boolean;
  /** The property's numbered rooms — the agreement must name one of them. */
  rooms: { id: string; roomNumber: string }[];
};

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";
const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";

type FormState = {
  tenantName: string;
  sublessorName: string;
  propertyAddress: string;
  roomNumber: string;
  rent: string;
  proRateRent: string;
  securityDeposit: string;
  leaseStartDate: string;
  leaseEndDate: string;
  agreementDate: string;
};

function daysInMonthOf(dateStr: string): number | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}

function dayOf(dateStr: string): number | null {
  const m = dateStr.match(/^\d{4}-\d{2}-(\d{2})$/);
  return m ? Number(m[1]) : null;
}

export function AgreementGenerator({
  prefills,
  propertyOptions,
  defaultAgreementDate,
  hasOperatorSignature,
}: {
  prefills: TenancyPrefill[];
  propertyOptions: PropertyOption[];
  defaultAgreementDate: string;
  hasOperatorSignature: boolean;
}) {
  const [form, setForm] = useState<FormState>({
    tenantName: "",
    sublessorName: "Vineet Dutta",
    propertyAddress: "",
    roomNumber: "",
    rent: "",
    proRateRent: "",
    securityDeposit: "",
    leaseStartDate: "",
    leaseEndDate: "",
    agreementDate: defaultAgreementDate,
  });
  const [selectedPrefill, setSelectedPrefill] = useState("");
  const [showCalculator, setShowCalculator] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  // Must be set before sending — pre-chosen from the property record when a
  // unit or tenant is picked, otherwise left for the user to choose.
  const [inNewYork, setInNewYork] = useState<boolean | null>(null);
  const [coverNote, setCoverNote] = useState("");
  const [sending, setSending] = useState(false);
  // Set only by picking from the property dropdown (or a prefill); cleared as
  // soon as the address text is hand-edited so the server re-matches it.
  const [propertyId, setPropertyId] = useState("");
  // Set when the room is picked from the property's room list; cleared when
  // the room is typed or the property changes so the server re-matches it.
  const [roomId, setRoomId] = useState("");
  const [showProperties, setShowProperties] = useState(false);

  const set = (field: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const selected = prefills.find((p) => p.id === selectedPrefill);

  const propertyMatches = useMemo(() => {
    const tokens = form.propertyAddress
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.length === 0) return propertyOptions;
    return propertyOptions.filter((p) => {
      const hay = `${p.label} ${p.address}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [form.propertyAddress, propertyOptions]);

  // Rooms offered for the picked property; empty when the address was typed
  // by hand (the server then matches the typed room number itself).
  const roomOptions = useMemo(
    () => propertyOptions.find((p) => p.id === propertyId)?.rooms ?? [],
    [propertyId, propertyOptions],
  );

  const pickProperty = (p: PropertyOption) => {
    // A different unit has different rooms — never carry a room across.
    setForm((prev) => ({
      ...prev,
      propertyAddress: p.address,
      roomNumber: p.rooms.length === 1 ? p.rooms[0].roomNumber : "",
    }));
    setPropertyId(p.id);
    setRoomId(p.rooms.length === 1 ? p.rooms[0].id : "");
    setInNewYork(p.isNewYork);
    setShowProperties(false);
  };

  const pickRoom = (id: string) => {
    const room = roomOptions.find((r) => r.id === id);
    setRoomId(room?.id ?? "");
    setForm((prev) => ({ ...prev, roomNumber: room?.roomNumber ?? "" }));
  };

  const applyPrefill = (id: string) => {
    setSelectedPrefill(id);
    const p = prefills.find((x) => x.id === id);
    if (!p) return;
    const option = propertyOptions.find((o) => o.id === p.propertyId);
    setForm((prev) => ({
      ...prev,
      tenantName: p.tenantName,
      propertyAddress: option?.address ?? p.propertyAddress,
      roomNumber: p.roomNumber,
      rent: p.rent,
      securityDeposit: p.securityDeposit,
      leaseStartDate: p.leaseStartDate,
      leaseEndDate: p.leaseEndDate,
    }));
    setPropertyId(p.propertyId);
    setRoomId(p.roomId);
    setRecipientEmail(p.tenantEmail);
    setInNewYork(p.isNewYork);
  };

  const proration = useMemo(() => {
    const rent = parseFloat(form.rent);
    const daysInMonth = daysInMonthOf(form.leaseStartDate);
    const moveDay = dayOf(form.leaseStartDate);
    if (!rent || rent <= 0 || !daysInMonth || !moveDay) return null;
    const daysOccupied = daysInMonth - moveDay + 1;
    const dailyRate = rent / daysInMonth;
    return {
      daysOccupied,
      daysInMonth,
      dailyRate,
      prorated: Math.round(dailyRate * daysOccupied * 100) / 100,
    };
  }, [form.rent, form.leaseStartDate]);

  const missing = () => {
    if (!form.tenantName.trim()) return "tenant name";
    if (!form.sublessorName.trim()) return "sublessor name";
    if (!form.propertyAddress.trim()) return "property address";
    if (!form.roomNumber.trim()) return "room number";
    if (!form.rent.trim()) return "monthly rent";
    if (!form.securityDeposit.trim()) return "security deposit";
    if (!form.leaseStartDate) return "lease start date";
    if (!form.leaseEndDate) return "lease end date";
    if (!form.agreementDate) return "agreement date";
    return null;
  };

  const validate = (): boolean => {
    const gap = missing();
    if (gap) {
      toast.error(`Fill in the ${gap} first.`);
      return false;
    }
    if (form.leaseEndDate <= form.leaseStartDate) {
      toast.error("Lease end date must be after the start date.");
      return false;
    }
    return true;
  };

  const send = async () => {
    if (!validate()) return;
    if (!recipientEmail.trim()) {
      toast.error("Fill in the tenant's email first.");
      return;
    }
    if (inNewYork === null) {
      toast.error("Choose whether this is a New York or non-New York apartment.");
      return;
    }
    setSending(true);
    try {
      const res = await sendAgreementToTenant({
        tenantName: form.tenantName.trim(),
        sublessorName: form.sublessorName.trim(),
        propertyAddress: form.propertyAddress.trim(),
        roomNumber: form.roomNumber.trim(),
        roomId: roomId || undefined,
        rent: form.rent.trim(),
        securityDeposit: form.securityDeposit.trim(),
        leaseStartDate: form.leaseStartDate,
        leaseEndDate: form.leaseEndDate,
        agreementDate: form.agreementDate,
        proRateRent: form.proRateRent.trim() || undefined,
        recipientEmail: recipientEmail.trim(),
        inNewYork,
        propertyId: propertyId || undefined,
        note: coverNote.trim() || undefined,
      });
      if (res.ok) {
        toast.success(
          `Agreement sent to ${recipientEmail.trim()} with a 48-hour signing link.`,
        );
      } else {
        toast.error(res.error ?? "Failed to send the agreement.");
      }
    } finally {
      setSending(false);
    }
  };

  const generate = (includeLetterhead: boolean) => {
    if (!validate()) return;
    try {
      const pdf = buildAgreementPdf({
        tenantName: form.tenantName.trim(),
        sublessorName: form.sublessorName.trim(),
        propertyAddress: form.propertyAddress.trim(),
        roomNumber: form.roomNumber.trim(),
        rent: form.rent.trim(),
        securityDeposit: form.securityDeposit.trim(),
        leaseStartDate: form.leaseStartDate,
        leaseEndDate: form.leaseEndDate,
        agreementDate: form.agreementDate,
        includeLetterhead,
        proRateRent: form.proRateRent.trim() || undefined,
      });
      pdf.save(agreementFilename(form.tenantName.trim()));
      toast.success(
        `${includeLetterhead ? "Letterhead" : "Plain"} agreement downloaded.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate the PDF.");
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Start from a tenant
        </h2>
        <p className="mt-1 text-xs text-muted">
          Optional — pick an active tenancy to prefill the form. Everything
          stays editable below.
        </p>
        <select
          value={selectedPrefill}
          onChange={(e) => applyPrefill(e.target.value)}
          className={`mt-4 w-full max-w-xl ${fieldInput}`}
        >
          <option value="">Blank agreement</option>
          {prefills.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {selected && (
          <p className="mt-2 text-xs text-muted">
            {selected.isNewYork ? (
              <>
                This unit is in <strong className="text-ink">New York</strong>{" "}
                — use the plain PDF (no letterhead).
              </>
            ) : (
              <>This unit is outside New York — use the letterhead PDF.</>
            )}
          </p>
        )}
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Agreement details
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Tenant name (sublessee) *</span>
            <input
              type="text"
              value={form.tenantName}
              onChange={(e) => set("tenantName")(e.target.value)}
              placeholder="e.g. Praveen Kumar Anwla"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Sublessor name *</span>
            <input
              type="text"
              value={form.sublessorName}
              onChange={(e) => set("sublessorName")(e.target.value)}
              className={fieldInput}
            />
          </label>
          <div className="relative flex flex-col gap-1.5 sm:col-span-2">
            <span className={fieldLabel}>Property address *</span>
            <input
              type="text"
              value={form.propertyAddress}
              onChange={(e) => {
                set("propertyAddress")(e.target.value);
                setPropertyId("");
                setRoomId("");
                setShowProperties(true);
              }}
              onFocus={() => setShowProperties(true)}
              onBlur={() => setShowProperties(false)}
              placeholder="Search your properties — e.g. Singh 804 or 335 Central"
              className={fieldInput}
            />
            {showProperties && propertyMatches.length > 0 && (
              <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-stone bg-white shadow-lg">
                {propertyMatches.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      // onMouseDown fires before the input's blur closes the
                      // list — preventDefault keeps the click from being lost.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickProperty(p);
                      }}
                      className="flex w-full flex-col items-start px-3 py-2 text-left transition hover:bg-warm"
                    >
                      <span className="text-sm text-ink">{p.label}</span>
                      <span className="text-xs text-muted">{p.address}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="text-[11px] text-muted">
              Agreements only go out for properties already in the portal —
              pick one from the list.
            </span>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Room *</span>
            {propertyId && roomOptions.length > 0 ? (
              <select
                value={roomId}
                onChange={(e) => pickRoom(e.target.value)}
                className={fieldInput}
              >
                <option value="">Pick a room…</option>
                {roomOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    Room {r.roomNumber}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={form.roomNumber}
                onChange={(e) => {
                  set("roomNumber")(e.target.value);
                  setRoomId("");
                }}
                placeholder="e.g. 3"
                className={fieldInput}
              />
            )}
            <span className="text-[11px] text-muted">
              {propertyId && roomOptions.length === 0
                ? "This property has no numbered rooms yet — number them on the property page first."
                : "The agreement names this room; it must be one of the property's rooms."}
            </span>
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Monthly rent ($) *</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.rent}
              onChange={(e) => set("rent")(e.target.value)}
              placeholder="e.g. 1650"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between">
              <span className={fieldLabel}>Prorated rent ($)</span>
              <button
                type="button"
                onClick={() => setShowCalculator((v) => !v)}
                className="text-[10px] font-semibold uppercase tracking-wider text-accent-text hover:text-accent-dark"
              >
                {showCalculator ? "Hide calculator" : "Calculate"}
              </button>
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.proRateRent}
              onChange={(e) => set("proRateRent")(e.target.value)}
              placeholder="Optional"
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Security deposit ($) *</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.securityDeposit}
              onChange={(e) => set("securityDeposit")(e.target.value)}
              placeholder="e.g. 1650"
              className={fieldInput}
            />
          </label>
        </div>

        {showCalculator && (
          <div className="mt-4 rounded-xl bg-warm/60 p-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
              Prorated rent calculator
            </h3>
            {proration ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-ink">
                <span>
                  Days occupied{" "}
                  <strong>
                    {proration.daysOccupied} / {proration.daysInMonth}
                  </strong>
                </span>
                <span>
                  Daily rate <strong>${proration.dailyRate.toFixed(2)}</strong>
                </span>
                <span>
                  Prorated rent{" "}
                  <strong className="text-accent-text">
                    ${proration.prorated.toFixed(2)}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => set("proRateRent")(proration.prorated.toFixed(2))}
                  className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark"
                >
                  Apply
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Enter the monthly rent and lease start date — the move-in month
                is prorated from that day through month end.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Lease start *</span>
            <input
              type="date"
              value={form.leaseStartDate}
              onChange={(e) => set("leaseStartDate")(e.target.value)}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Lease end *</span>
            <input
              type="date"
              value={form.leaseEndDate}
              onChange={(e) => set("leaseEndDate")(e.target.value)}
              className={fieldInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Agreement date *</span>
            <input
              type="date"
              value={form.agreementDate}
              onChange={(e) => set("agreementDate")(e.target.value)}
              className={fieldInput}
            />
          </label>
        </div>

        <div className="mt-6 border-t border-stone/50 pt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => generate(true)}
              className="rounded-full bg-accent px-6 py-3 text-sm font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark"
            >
              Download with letterhead
            </button>
            <button
              type="button"
              onClick={() => generate(false)}
              className="rounded-full border border-ink px-6 py-3 text-sm font-medium uppercase tracking-wide text-ink transition hover:bg-warm"
            >
              Download plain (New York)
            </button>
          </div>
          <p className="mt-3 text-center text-xs text-muted">
            Downloads are generated in your browser and are unsigned — nothing
            leaves the portal.
          </p>
        </div>

        <div className="mt-6 border-t border-stone/50 pt-6">
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted">
            Email to tenant for signing
          </h3>
          <p className="mt-1 text-xs text-muted">
            Sends the agreement — pre-signed by you — with a 48-hour online
            signing link, and adds the tenant to the signing tally above.
          </p>
          <div className="mt-4 grid items-end gap-4 sm:grid-cols-[1fr_auto_auto]">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Tenant email *</span>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="tenant@example.com"
                className={fieldInput}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Apartment location *</span>
              <div
                role="radiogroup"
                aria-label="Apartment location"
                className="flex rounded-full border border-stone bg-white p-1"
              >
                {[
                  { value: true, label: "New York" },
                  { value: false, label: "Non-New York" },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    role="radio"
                    aria-checked={inNewYork === opt.value}
                    onClick={() => setInNewYork(opt.value)}
                    className={`rounded-full px-4 py-1.5 text-sm transition ${
                      inNewYork === opt.value
                        ? "bg-ink text-white"
                        : "text-ink hover:bg-warm"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={send}
              disabled={sending || !hasOperatorSignature || inNewYork === null}
              className="rounded-full bg-ink px-6 py-3 text-sm font-medium uppercase tracking-wide text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? "Sending…" : "Send to tenant"}
            </button>
          </div>
          <label className="mt-4 flex flex-col gap-1.5">
            <span className={fieldLabel}>Note in the cover email (optional)</span>
            <textarea
              value={coverNote}
              onChange={(e) => setCoverNote(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="e.g. The earlier agreement was sent by mistake — this one replaces it."
              className={fieldInput}
            />
            <span className="text-xs text-muted">
              Email only — not stored, not in the PDF, and not repeated if you
              resend.
            </span>
          </label>
          <p className="mt-3 text-xs text-muted">
            {hasOperatorSignature ? (
              inNewYork === null ? (
                <span className="text-amber-800">
                  Choose New York or Non-New York before sending.
                </span>
              ) : inNewYork ? (
                <>
                  New York: sent plain from the personal Gmail, no letterhead or
                  branding.
                </>
              ) : (
                <>Sent branded from the Outlook work account, with letterhead.</>
              )
            ) : (
              <span className="text-amber-800">
                Draw your signature at the top of this page first — sending is
                disabled until it&rsquo;s on file.
              </span>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
