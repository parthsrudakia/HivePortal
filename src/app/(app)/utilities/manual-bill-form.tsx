"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { commitManualBills, type UploadState } from "./actions";
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
};

const FIRST_ROW: Row = { id: 0, start: "", end: "", amount: "" };

/**
 * Manual bill entry: the operator types every field themselves — nothing is
 * extracted or pre-filled. The attached screenshot is never read; it is only
 * stored as each logged bill's statement (and its hash blocks re-uploads).
 * Each cycle row becomes its own bill sharing that statement.
 *
 * The screenshot lives in state rather than the input: React resets
 * uncontrolled form fields after every form action, which would otherwise
 * clear the file on a failed submit and silently block resubmission.
 */
export function ManualBillForm({ units }: { units: UnitOpt[] }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[]>([FIRST_ROW]);
  const [nextRowId, setNextRowId] = useState(1);
  // Bumped after each successful save so the remounted form starts blank.
  const [resetKey, setResetKey] = useState(0);

  const setRowField = (id: number, field: "start" | "end" | "amount", v: string) =>
    setRows((r) => r.map((x) => (x.id === id ? { ...x, [field]: v } : x)));

  const close = () => {
    setOpen(false);
    setRows([FIRST_ROW]);
    setNextRowId(1);
    setFile(null);
  };

  const [commitState, commitAction, commitPending] = useActionState<
    UploadState,
    FormData
  >(async (prev, formData) => {
    if (!file) {
      toast.error("Attach the bill screenshot first.");
      return prev;
    }
    formData.set("screenshot", file);
    const result = await commitManualBills(prev, formData);
    if (result?.warning) toast.warning(result.warning);
    if (result?.success) {
      setResetKey((k) => k + 1);
      close();
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
          Enter a bill manually
        </button>
      </p>
    );
  }

  return (
    <form key={resetKey} className="mt-3 rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Enter bills manually
        </h2>
        <button
          type="button"
          onClick={close}
          className="text-xs uppercase tracking-wide text-muted hover:text-accent-text"
        >
          Cancel
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Unit</span>
          <select
            name="property_id"
            required
            defaultValue=""
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
            defaultValue=""
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
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Provider (optional)</span>
          <input
            name="provider"
            placeholder="e.g. PSE&G, Con Edison"
            className={fieldInput}
          />
        </label>
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
              ? `Holding ${file.name} — stored as the bill's statement.`
              : "Not read — only stored as the statement. PDF or photo, up to 20 MB."}
          </span>
        </label>
      </div>

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
              { id: nextRowId, start: "", end: "", amount: "" },
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

      <div className="mt-5">
        <button
          type="submit"
          formAction={commitAction}
          disabled={commitPending || !file}
          className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:opacity-60"
        >
          {commitPending
            ? "Saving…"
            : rows.length === 1
              ? "Log bill"
              : `Log ${rows.length} bills`}
        </button>
      </div>
    </form>
  );
}
