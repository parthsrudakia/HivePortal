"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import {
  commitManualBills,
  previewManualBill,
  type ManualPrefill,
  type ManualPreviewState,
  type UploadState,
} from "./actions";
import { useFormToast } from "@/components/use-form-toast";
import type { UnitOpt } from "./bill-utils";

const TYPE_OPTIONS = [
  ["electric", "Electric"],
  ["gas", "Gas"],
  ["water", "Water"],
  ["internet", "Internet"],
  ["trash", "Trash"],
  ["other", "Other"],
] as const;

const fieldInput =
  "rounded-lg border border-stone bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none";
const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted";

type Row = {
  id: number;
  start: string;
  end: string;
  amount: string;
  chargesJson: string;
};

/**
 * Manual bill entry, screenshot-first: attach a screenshot (one statement or
 * a multi-month account ledger), extraction pre-fills the fields, the
 * operator corrects anything wrong, then submits. Each reviewed cycle
 * becomes its own bill; the screenshot is stored as every bill's statement.
 *
 * Everything the operator can edit is CONTROLLED state, and the screenshot
 * lives in state rather than the input: React resets uncontrolled form
 * fields after every form action, which would otherwise clear the file
 * between the preview and the commit and silently block submission on the
 * hidden required input.
 */
export function ManualBillForm({ units }: { units: UnitOpt[] }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [prefill, setPrefill] = useState<ManualPrefill | null>(null);
  const [unitId, setUnitId] = useState("");
  const [utilityType, setUtilityType] = useState("");
  const [nextRowId, setNextRowId] = useState(0);
  // Bumped after each successful save so the remounted form starts blank.
  const [resetKey, setResetKey] = useState(0);

  const setRowField = (id: number, field: "start" | "end" | "amount", v: string) =>
    setRows((r) => r.map((x) => (x.id === id ? { ...x, [field]: v } : x)));

  const seedFromPrefill = (p: ManualPrefill) => {
    setPrefill(p);
    setUnitId(p.property_id ?? "");
    setUtilityType(p.utility_type ?? "");
    const seeded: Row[] = (p.cycles.length > 0 ? p.cycles : [null]).map(
      (c, i) => ({
        id: i,
        start: c?.period_start ?? "",
        end: c?.period_end ?? "",
        amount: c?.amount != null ? c.amount.toFixed(2) : "",
        chargesJson: JSON.stringify(c?.charges ?? []),
      }),
    );
    setRows(seeded);
    setNextRowId(seeded.length);
  };

  const [, previewAction, previewPending] = useActionState<
    ManualPreviewState,
    FormData
  >(async (prev, formData) => {
    if (!file) {
      toast.error("Attach a screenshot first.");
      return prev;
    }
    formData.set("screenshot", file);
    const result = await previewManualBill(prev, formData);
    if (result?.error) toast.error(result.error);
    if (result?.warning) toast.warning(result.warning);
    if (result?.prefill) seedFromPrefill(result.prefill);
    return result;
  }, undefined);

  const [commitState, commitAction, commitPending] = useActionState<
    UploadState,
    FormData
  >(async (prev, formData) => {
    if (!file) {
      toast.error("The screenshot went missing — attach it again.");
      return prev;
    }
    formData.set("screenshot", file);
    const result = await commitManualBills(prev, formData);
    if (result?.warning) toast.warning(result.warning);
    if (result?.success) {
      setResetKey((k) => k + 1);
      setPrefill(null);
      setRows([]);
      setFile(null);
      setOpen(false);
    }
    return result;
  }, undefined);
  useFormToast({
    pending: commitPending,
    state: commitState,
    successMessage: "Logged",
  });

  if (!open) {
    return (
      <p className="mt-2 text-center text-xs text-muted">
        Statement won&apos;t scan, or logging from an account ledger?{" "}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-accent-text hover:underline"
        >
          Enter bills from a screenshot
        </button>
      </p>
    );
  }

  const reviewing = prefill !== null;

  return (
    <form key={resetKey} className="mt-3 rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          {reviewing ? "Review & correct, then log" : "Enter bills from a screenshot"}
        </h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setPrefill(null);
            setRows([]);
            setFile(null);
          }}
          className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
        >
          Cancel
        </button>
      </div>

      {!reviewing && (
        <div className="mt-4">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Bill screenshot</span>
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-warm file:px-3 file:py-2 file:text-sm file:text-ink hover:file:bg-stone/40"
            />
            <span className="text-xs text-muted">
              {file
                ? `Holding ${file.name} — it's read to pre-fill the fields, and stored as the statement.`
                : "One statement or a multi-month account ledger — PDF or photo, up to 20 MB."}
            </span>
          </label>
          <button
            type="submit"
            formAction={previewAction}
            disabled={previewPending || !file}
            className="mt-4 rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
          >
            {previewPending ? "Reading…" : "Read screenshot"}
          </button>
        </div>
      )}

      {reviewing && (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Unit</span>
              <select
                name="property_id"
                required
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className={fieldInput}
              >
                <option value="" disabled>
                  Pick a unit…
                </option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Utility type</span>
              <select
                name="utility_type"
                required
                value={utilityType}
                onChange={(e) => setUtilityType(e.target.value)}
                className={fieldInput}
              >
                <option value="" disabled>
                  Pick a type…
                </option>
                {TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {(prefill.provider || prefill.service_address) && (
            <p className="mt-3 text-xs text-muted">
              Read from the screenshot:{" "}
              {[prefill.provider, prefill.service_address]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_1fr_1fr_2rem] gap-2">
              <span className={fieldLabel}>Period start</span>
              <span className={fieldLabel}>Period end</span>
              <span className={fieldLabel}>Amount</span>
              <span />
            </div>
            {rows.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[1fr_1fr_1fr_2rem] items-center gap-2"
              >
                <input
                  type="date"
                  name={`period_start:${row.id}`}
                  required
                  value={row.start}
                  onChange={(e) => setRowField(row.id, "start", e.target.value)}
                  className={fieldInput}
                />
                <input
                  type="date"
                  name={`period_end:${row.id}`}
                  required
                  value={row.end}
                  onChange={(e) => setRowField(row.id, "end", e.target.value)}
                  className={fieldInput}
                />
                <input
                  name={`amount:${row.id}`}
                  required
                  inputMode="decimal"
                  placeholder="$123.45"
                  value={row.amount}
                  onChange={(e) => setRowField(row.id, "amount", e.target.value)}
                  className={fieldInput}
                />
                <input
                  type="hidden"
                  name={`charges:${row.id}`}
                  value={row.chargesJson}
                />
                <button
                  type="button"
                  onClick={() => setRows((r) => r.filter((x) => x.id !== row.id))}
                  disabled={rows.length === 1}
                  className="text-muted transition hover:text-red-700 disabled:opacity-30"
                  title="Remove this cycle"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                setRows((r) => [
                  ...r,
                  { id: nextRowId, start: "", end: "", amount: "", chargesJson: "[]" },
                ]);
                setNextRowId((n) => n + 1);
              }}
              className="self-start text-xs text-accent-text hover:underline"
            >
              + Add a cycle
            </button>
          </div>

          <input
            type="hidden"
            name="row_ids"
            value={rows.map((r) => r.id).join(",")}
          />
          <input type="hidden" name="provider" value={prefill.provider ?? ""} />
          <input
            type="hidden"
            name="account_number"
            value={prefill.account_number ?? ""}
          />
          <input
            type="hidden"
            name="service_address"
            value={prefill.service_address ?? ""}
          />
          <input
            type="hidden"
            name="statement_date"
            value={prefill.statement_date ?? ""}
          />
          <input
            type="hidden"
            name="extract_notes"
            value={prefill.notes ?? ""}
          />

          <div className="mt-5 flex items-center gap-4">
            <button
              type="submit"
              formAction={commitAction}
              disabled={commitPending}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
            >
              {commitPending
                ? "Saving…"
                : rows.length === 1
                  ? "Log bill"
                  : `Log ${rows.length} bills`}
            </button>
            <button
              type="button"
              onClick={() => {
                setPrefill(null);
                setRows([]);
                setFile(null);
              }}
              className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
            >
              Different screenshot
            </button>
          </div>
        </>
      )}
    </form>
  );
}
