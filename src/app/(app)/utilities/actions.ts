"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  extractUtilityBill,
  extractUtilityCycles,
  type UnitOption,
} from "@/lib/utility-extract";
import { compressStatement } from "@/lib/compress-statement";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { canEditLedger, LEDGER_ADMIN_ERROR } from "@/lib/access";
import {
  sendUtilityChargeNotice,
  sendUtilityChargeNoticeGmail,
} from "@/lib/email";
import {
  billMonth,
  isOverThreshold,
  monthLabel,
  usageTotal,
  OVERAGE_THRESHOLD,
  type BillRow,
} from "@/lib/utility-bills";

export type UploadState =
  | { error?: string; success?: string; warning?: string }
  | undefined;

const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;

// Normalized hint keys for the learned statement→unit mappings.
function hintKeys(bill: {
  account_number: string | null;
  service_address: string | null;
}): string[] {
  const keys: string[] = [];
  const acct = bill.account_number?.replace(/\D/g, "");
  if (acct) keys.push(`acct:${acct}`);
  const addr = bill.service_address?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (addr) keys.push(`addr:${addr}`);
  return keys;
}

export async function uploadStatement(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const file = formData.get("statement");
  if (!(file instanceof File) || file.size === 0)
    return { error: "Drop a statement file first." };
  if (file.size > MAX_STATEMENT_BYTES)
    return { error: "Statement must be 20 MB or smaller." };
  const mediaType = file.type || "application/pdf";

  // Session client (not service-role) so the audit log attributes the
  // upload to the signed-in user. Same for the other mutations below.
  const sb = supabase;

  // Units for address matching.
  const { data: props } = await sb
    .from("properties")
    .select("id, building_name, street_address, unit_number");
  const units: UnitOption[] = (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
    street_address: p.street_address,
    unit_number: p.unit_number,
  }));

  const buf = Buffer.from(await file.arrayBuffer());

  // Duplicate guard 1: the exact same file was uploaded before. Checked
  // before extraction so a re-drop doesn't burn an extraction call.
  const fileHash = createHash("sha256").update(buf).digest("hex");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dup } = await (sb as any)
      .from("utility_bills")
      .select("id, provider, statement_date")
      .eq("file_sha256", fileHash)
      .maybeSingle();
    if (dup) {
      const what = [dup.provider, dup.statement_date && `statement ${dup.statement_date}`]
        .filter(Boolean)
        .join(", ");
      return {
        error: `Duplicate — this exact file is already in the log${what ? ` (${what})` : ""}. Discarded.`,
      };
    }
  }

  // Extract — if Claude can't read it, don't leave an orphaned upload.
  let extracted;
  try {
    extracted = await extractUtilityBill(
      { base64: buf.toString("base64"), mediaType },
      units,
    );
  } catch (e) {
    return {
      error: `Could not read the statement: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }

  // The model's unit match is untrusted output from reading the statement —
  // never let it write an id outside the known unit list.
  if (
    extracted.property_id &&
    !units.some((u) => u.id === extracted.property_id)
  ) {
    extracted.property_id = null;
  }

  // Operator-confirmed mappings beat the model's guess: if this account or
  // service address was ever manually assigned to a unit, reuse that unit.
  const keys = hintKeys(extracted);
  let learned = false;
  if (keys.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: hints } = await (sb as any)
      .from("utility_unit_hints")
      .select("key, property_id")
      .in("key", keys);
    const hint = (hints ?? [])[0];
    if (hint && hint.property_id !== extracted.property_id) {
      extracted.property_id = hint.property_id;
      learned = true;
    }
  }

  if (extracted.charges.length === 0) {
    return {
      error:
        "No current-cycle charges found on that statement (previous-balance " +
        "amounts are ignored by design). Check the file and try again.",
    };
  }

  // Duplicate guard 2: the same bill re-scanned or exported again, OR a
  // statement whose billing period substantially overlaps one already logged
  // for the same account (catch-up statements re-covering a prior cycle).
  // Consecutive real cycles legitimately overlap by a couple of days at the
  // meter-read boundary (PSE&G: 5/14–6/15 then 6/13–7/15), so only an overlap
  // of MORE THAN 7 days counts as a duplicate.
  {
    const DUP_OVERLAP_DAYS = 7;
    const overlapDays = (
      aStart: string,
      aEnd: string,
      bStart: string,
      bEnd: string,
    ) => {
      const ms =
        Math.min(Date.parse(`${aEnd}T00:00:00Z`), Date.parse(`${bEnd}T00:00:00Z`)) -
        Math.max(
          Date.parse(`${aStart}T00:00:00Z`),
          Date.parse(`${bStart}T00:00:00Z`),
        );
      return ms / 86_400_000;
    };
    const acct = extracted.account_number?.replace(/\D/g, "") || null;
    if (acct && (extracted.period_start || extracted.statement_date)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (sb as any)
        .from("utility_bills")
        .select(
          "id, account_number, provider, utility_type, period_start, period_end",
        );
      if (extracted.period_start && extracted.period_end) {
        q = q
          .lt("period_start", extracted.period_end)
          .gt("period_end", extracted.period_start);
      } else {
        q = q.eq("statement_date", extracted.statement_date);
      }
      const { data: candidates } = await q;
      const dup = (candidates ?? []).find(
        (c: {
          account_number: string | null;
          utility_type: string | null;
          period_start: string | null;
          period_end: string | null;
        }) =>
          (c.account_number ?? "").replace(/\D/g, "") === acct &&
          // Same account can bill different services on separate statements
          // with overlapping periods — only same-type overlap is a duplicate.
          c.utility_type === extracted.utility_type &&
          // Overlap query ran only when the new bill has both dates; matching
          // on statement_date (no period on the new bill) is always a dup.
          (!extracted.period_start ||
            !extracted.period_end ||
            !c.period_start ||
            !c.period_end ||
            overlapDays(
              c.period_start,
              c.period_end,
              extracted.period_start,
              extracted.period_end,
            ) > DUP_OVERLAP_DAYS),
      );
      if (dup) {
        const covered =
          dup.period_start && dup.period_end
            ? ` covering ${dup.period_start} – ${dup.period_end}`
            : " for this period";
        return {
          error:
            `Duplicate — a ${dup.utility_type ?? ""} bill for this account` +
            `${covered} is already in the log` +
            `${dup.provider ? ` (${dup.provider})` : ""}. Discarded.`,
        };
      }
    }
  }

  // Store the statement, compressed as far as it will go (extraction above
  // already ran on the original bytes; the hash also covers the original).
  const compressed = await compressStatement(buf, mediaType);
  let safeName = file.name.replace(/[^\w.\-]/g, "_") || "statement";
  if (compressed.mediaType === "image/webp" && !/\.webp$/i.test(safeName)) {
    safeName = safeName.replace(/\.[a-z0-9]+$/i, "") + ".webp";
  }
  const path = `${extracted.property_id ?? "unmatched"}/${Date.now()}-${safeName}`;
  const { error: upErr } = await sb.storage
    .from("utilities")
    .upload(path, compressed.data, {
      contentType: compressed.mediaType,
      upsert: false,
    });
  if (upErr) return { error: `Failed to store the statement: ${upErr.message}` };

  const total =
    Math.round(extracted.charges.reduce((s, c) => s + c.amount, 0) * 100) /
    100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error: insErr } = await (sb as any)
    .from("utility_bills")
    .insert({
      property_id: extracted.property_id,
      provider: extracted.provider,
      utility_type: extracted.utility_type,
      account_number: extracted.account_number,
      service_address: extracted.service_address,
      statement_date: extracted.statement_date,
      period_start: extracted.period_start,
      period_end: extracted.period_end,
      total_amount: total,
      statement_path: path,
      file_sha256: fileHash,
      notes: extracted.notes,
    })
    .select("id")
    .single();
  if (insErr) {
    await sb.storage.from("utilities").remove([path]);
    return { error: insErr.message };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: chErr } = await (sb as any).from("utility_bill_charges").insert(
    extracted.charges.map((c) => ({
      bill_id: bill.id,
      kind: c.kind,
      description: c.description,
      amount: c.amount,
    })),
  );
  if (chErr) {
    // Don't strand a bill with a total but no charge rows: it would show in
    // the log yet never trip the over-$200 check, and its file hash would
    // block re-uploading the statement.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb as any).from("utility_bills").delete().eq("id", bill.id);
    await sb.storage.from("utilities").remove([path]);
    return { error: chErr.message };
  }

  revalidatePath("/utilities");
  const unit = units.find((u) => u.id === extracted.property_id);
  const extras = extracted.charges.filter((c) => c.kind !== "current");
  const parts = [
    `Logged $${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    extracted.provider ?? "utility",
    unit ? `for ${unit.label}` : "",
    learned ? "(matched from your earlier manual assignment)" : "",
    extras.length
      ? `(${extras.length} late-fee/other charge${extras.length === 1 ? "" : "s"} saved separately)`
      : "",
  ].filter(Boolean);
  return {
    success: parts.join(" "),
    warning: !extracted.property_id
      ? "Couldn't match the service address to a unit — assign it in the log below."
      : undefined,
  };
}

// ----------------------------------------------------------------------------
// Manual bill entry, two steps:
//   1. previewManualBill — reads the screenshot (single statement OR a
//      multi-month account ledger) into prefill the operator reviews/corrects.
//   2. commitManualBills — saves the corrected rows; the screenshot is stored
//      once and shared as the statement of every bill it produced.
// ----------------------------------------------------------------------------

const MANUAL_TYPES = new Set([
  "electric",
  "gas",
  "water",
  "internet",
  "trash",
  "other",
]);

const MAX_MANUAL_CYCLES = 24;

type ManualCharge = { kind: string; description: string; amount: number };

export type ManualPrefill = {
  property_id: string | null;
  utility_type: string | null;
  provider: string | null;
  account_number: string | null;
  service_address: string | null;
  statement_date: string | null;
  notes: string | null;
  cycles: {
    period_start: string | null;
    period_end: string | null;
    amount: number | null;
    charges: ManualCharge[];
  }[];
};

export type ManualPreviewState =
  | { error?: string; warning?: string; prefill?: ManualPrefill }
  | undefined;

function screenshotProblem(file: unknown): string | null {
  if (!(file instanceof File) || file.size === 0)
    return "Attach a screenshot of the bill first.";
  if (file.size > MAX_STATEMENT_BYTES)
    return "Screenshot must be 20 MB or smaller.";
  const mediaType = file.type || "application/octet-stream";
  if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(mediaType))
    return "Screenshot must be a PDF or a PNG/JPEG/WebP image.";
  return null;
}

const EMPTY_PREFILL: ManualPrefill = {
  property_id: null,
  utility_type: null,
  provider: null,
  account_number: null,
  service_address: null,
  statement_date: null,
  notes: null,
  cycles: [],
};

export async function previewManualBill(
  _prev: ManualPreviewState,
  formData: FormData,
): Promise<ManualPreviewState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const file = formData.get("screenshot");
  const problem = screenshotProblem(file);
  if (problem) return { error: problem };
  const screenshot = file as File;
  const mediaType = screenshot.type || "application/pdf";

  const buf = Buffer.from(await screenshot.arrayBuffer());
  const fileHash = createHash("sha256").update(buf).digest("hex");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dup } = await (supabase as any)
      .from("utility_bills")
      .select("id")
      .eq("file_sha256", fileHash)
      .maybeSingle();
    if (dup)
      return {
        error:
          "Duplicate — this exact file is already attached to a logged bill.",
      };
  }

  const { data: props } = await supabase
    .from("properties")
    .select("id, building_name, street_address, unit_number");
  const units: UnitOption[] = (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
    street_address: p.street_address,
    unit_number: p.unit_number,
  }));

  try {
    const extracted = await extractUtilityCycles(
      { base64: buf.toString("base64"), mediaType },
      units,
    );
    const knownUnit =
      extracted.property_id &&
      units.some((u) => u.id === extracted.property_id);
    // Extraction sometimes splits one bill into several "cycles" with the
    // same period (e.g. a combined statement's electric + gas portions).
    // Same period = same bill: merge them so the overlap guard doesn't
    // reject the operator's own prefill.
    const merged: ManualPrefill["cycles"] = [];
    for (const c of extracted.cycles) {
      const twin = merged.find(
        (m) =>
          m.period_start === c.period_start && m.period_end === c.period_end,
      );
      if (twin) {
        twin.amount =
          Math.round(((twin.amount ?? 0) + c.amount) * 100) / 100;
        twin.charges = [...twin.charges, ...c.charges];
      } else {
        merged.push({
          period_start: c.period_start,
          period_end: c.period_end,
          amount: c.amount,
          charges: c.charges,
        });
      }
    }
    return {
      prefill: {
        property_id: knownUnit ? extracted.property_id : null,
        utility_type: extracted.utility_type,
        provider: extracted.provider,
        account_number: extracted.account_number,
        service_address: extracted.service_address,
        statement_date: extracted.statement_date,
        notes: extracted.notes,
        cycles: merged.slice(0, MAX_MANUAL_CYCLES),
      },
    };
  } catch {
    return {
      prefill: EMPTY_PREFILL,
      warning:
        "Couldn't read the screenshot — fill the fields in yourself; the " +
        "file is still saved as the statement.",
    };
  }
}

export async function commitManualBills(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const propertyId = String(formData.get("property_id") ?? "");
  const utilityType = String(formData.get("utility_type") ?? "");
  const file = formData.get("screenshot");

  if (!propertyId) return { error: "Pick the unit." };
  if (!MANUAL_TYPES.has(utilityType))
    return { error: "Pick the utility type." };
  const problem = screenshotProblem(file);
  if (problem) return { error: problem };
  const screenshot = file as File;
  const mediaType = screenshot.type || "application/pdf";

  // Rows the operator confirmed. Amounts/dates come from the reviewed form,
  // never straight from extraction.
  const rowIds = String(formData.get("row_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (rowIds.length === 0) return { error: "Add at least one billing cycle." };
  if (rowIds.length > MAX_MANUAL_CYCLES)
    return { error: `At most ${MAX_MANUAL_CYCLES} cycles per screenshot.` };

  type CycleInput = {
    start: string;
    end: string;
    amount: number;
    charges: ManualCharge[];
  };
  const cycles: CycleInput[] = [];
  for (const id of rowIds) {
    const start = String(formData.get(`period_start:${id}`) ?? "");
    const end = String(formData.get(`period_end:${id}`) ?? "");
    const amountRaw = String(formData.get(`amount:${id}`) ?? "").replace(
      /[$,\s]/g,
      "",
    );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
      return { error: "Every cycle needs both billing-period dates." };
    if (end < start)
      return { error: `Cycle ${start} – ${end} ends before it starts.` };
    if (start > todayISO())
      return { error: `Cycle ${start} – ${end} starts in the future.` };
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0)
      return { error: `Cycle ${start} – ${end} needs a valid amount.` };
    let charges: ManualCharge[] = [];
    try {
      const parsed = JSON.parse(String(formData.get(`charges:${id}`) ?? "[]"));
      if (Array.isArray(parsed)) {
        charges = parsed.filter(
          (c): c is ManualCharge =>
            !!c &&
            typeof c.kind === "string" &&
            ["current", "late_fee", "other"].includes(c.kind) &&
            typeof c.description === "string" &&
            typeof c.amount === "number" &&
            Number.isFinite(c.amount),
        );
      }
    } catch {
      charges = [];
    }
    cycles.push({ start, end, amount: Math.round(amount * 100) / 100, charges });
  }

  const overlapDays = (a: CycleInput, bStart: string, bEnd: string) => {
    const ms =
      Math.min(Date.parse(`${a.end}T00:00:00Z`), Date.parse(`${bEnd}T00:00:00Z`)) -
      Math.max(
        Date.parse(`${a.start}T00:00:00Z`),
        Date.parse(`${bStart}T00:00:00Z`),
      );
    return ms / 86_400_000;
  };

  // Cycles in one submission must not double-cover each other.
  for (let i = 0; i < cycles.length; i++) {
    for (let j = i + 1; j < cycles.length; j++) {
      if (overlapDays(cycles[i], cycles[j].start, cycles[j].end) > 7)
        return {
          error:
            `Cycles ${cycles[i].start} – ${cycles[i].end} and ` +
            `${cycles[j].start} – ${cycles[j].end} overlap — remove one.`,
        };
    }
  }

  const { data: prop } = await supabase
    .from("properties")
    .select("id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!prop) return { error: "Unknown unit." };

  const buf = Buffer.from(await screenshot.arrayBuffer());
  const fileHash = createHash("sha256").update(buf).digest("hex");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dup } = await (supabase as any)
      .from("utility_bills")
      .select("id")
      .eq("file_sha256", fileHash)
      .maybeSingle();
    if (dup)
      return {
        error:
          "Duplicate — this exact file is already attached to a logged bill.",
      };
  }

  // No account number on manual bills, so the against-the-log overlap guard
  // keys on unit + type: >7 days of overlap with a logged bill is a
  // duplicate (a couple of days is a normal meter-read boundary).
  {
    const minStart = cycles.reduce(
      (m, c) => (c.start < m ? c.start : m),
      cycles[0].start,
    );
    const maxEnd = cycles.reduce(
      (m, c) => (c.end > m ? c.end : m),
      cycles[0].end,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: candidates } = await (supabase as any)
      .from("utility_bills")
      .select("id, provider, period_start, period_end")
      .eq("property_id", propertyId)
      .eq("utility_type", utilityType)
      .lt("period_start", maxEnd)
      .gt("period_end", minStart);
    for (const c of cycles) {
      const hit = (candidates ?? []).find(
        (b: { period_start: string | null; period_end: string | null }) =>
          b.period_start &&
          b.period_end &&
          overlapDays(c, b.period_start, b.period_end) > 7,
      );
      if (hit)
        return {
          error:
            `A ${utilityType} bill for this unit already covers ` +
            `${hit.period_start} – ${hit.period_end}` +
            `${hit.provider ? ` (${hit.provider})` : ""} — remove the ` +
            `${c.start} – ${c.end} row.`,
        };
    }
  }

  const compressed = await compressStatement(buf, mediaType);
  let safeName = screenshot.name.replace(/[^\w.\-]/g, "_") || "screenshot";
  if (compressed.mediaType === "image/webp" && !/\.webp$/i.test(safeName)) {
    safeName = safeName.replace(/\.[a-z0-9]+$/i, "") + ".webp";
  }
  const path = `${propertyId}/${Date.now()}-manual-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from("utilities")
    .upload(path, compressed.data, {
      contentType: compressed.mediaType,
      upsert: false,
    });
  if (upErr)
    return { error: `Failed to store the screenshot: ${upErr.message}` };

  const provider = String(formData.get("provider") ?? "").trim() || null;
  const accountNumber =
    String(formData.get("account_number") ?? "").trim() || null;
  const serviceAddress =
    String(formData.get("service_address") ?? "").trim() || null;
  const statementDateRaw = String(formData.get("statement_date") ?? "").trim();
  const statementDate =
    cycles.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(statementDateRaw)
      ? statementDateRaw
      : null;
  const extractNotes = String(formData.get("extract_notes") ?? "").trim();
  const notes = ["Entered from a screenshot.", extractNotes]
    .filter(Boolean)
    .join(" ");

  const insertedBillIds: string[] = [];
  const rollback = async () => {
    if (insertedBillIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("utility_bills")
        .delete()
        .in("id", insertedBillIds);
    }
    await supabase.storage.from("utilities").remove([path]);
  };

  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bill, error: insErr } = await (supabase as any)
      .from("utility_bills")
      .insert({
        property_id: propertyId,
        provider,
        utility_type: utilityType,
        account_number: accountNumber,
        service_address: serviceAddress,
        statement_date: statementDate,
        period_start: c.start,
        period_end: c.end,
        total_amount: c.amount,
        statement_path: path,
        // Only the first bill carries the hash: the same-file guard needs
        // exactly one row per file (maybeSingle), and one is enough to block
        // a re-upload of this screenshot.
        file_sha256: i === 0 ? fileHash : null,
        notes,
      })
      .select("id")
      .single();
    if (insErr) {
      await rollback();
      return { error: insErr.message };
    }
    insertedBillIds.push(bill.id);

    // The extracted breakdown (late fees separated for the over-$200 split)
    // is used only when it still agrees with the reviewed amount to the cent.
    const breakdownTotal =
      Math.round(c.charges.reduce((s, ch) => s + ch.amount, 0) * 100) / 100;
    const chargeRows =
      c.charges.length > 0 && Math.abs(breakdownTotal - c.amount) <= 0.01
        ? c.charges.map((ch) => ({
            bill_id: bill.id,
            kind: ch.kind,
            description: ch.description,
            amount: ch.amount,
          }))
        : [
            {
              bill_id: bill.id,
              kind: "current",
              description: "Manual entry",
              amount: c.amount,
            },
          ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: chErr } = await (supabase as any)
      .from("utility_bill_charges")
      .insert(chargeRows);
    if (chErr) {
      await rollback();
      return { error: `Failed to save the charges: ${chErr.message}` };
    }
  }

  revalidatePath("/utilities");
  const totalLogged = cycles.reduce((s, c) => s + c.amount, 0);
  return {
    success:
      cycles.length === 1
        ? "Bill logged."
        : `${cycles.length} bills logged ($${totalLogged.toFixed(2)} total).`,
  };
}

export async function assignBillProperty(
  billId: string,
  propertyId: string | null,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const sb = supabase;
  // A charged bill's ledger charges belong to the current unit's tenants —
  // reassigning it would silently misattribute them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (sb as any)
    .from("utility_bills")
    .select("overage_charged_at")
    .eq("id", billId)
    .maybeSingle();
  if (existing?.overage_charged_at)
    return {
      error:
        "This bill's overage is charged to tenants — unpost it before reassigning the unit.",
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error } = await (sb as any)
    .from("utility_bills")
    .update({ property_id: propertyId })
    .eq("id", billId)
    .select("account_number, service_address")
    .single();
  if (error) return { error: error.message };

  // Learn from the correction: remember this account/address → unit so the
  // next statement from the same source is assigned automatically.
  const keys = bill ? hintKeys(bill) : [];
  if (keys.length > 0) {
    if (propertyId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any).from("utility_unit_hints").upsert(
        keys.map((key) => ({ key, property_id: propertyId })),
        { onConflict: "key" },
      );
    } else {
      // Un-assigning means the learned mapping was wrong — forget it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any).from("utility_unit_hints").delete().in("key", keys);
    }
  }
  revalidatePath("/utilities");
  return { success: "Bill reassigned." };
}

export async function deleteBill(billId: string): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const sb = supabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill } = await (sb as any)
    .from("utility_bills")
    .select("statement_path, overage_charged_at")
    .eq("id", billId)
    .maybeSingle();
  // Deleting a charged bill would sever tenancy_charges.bill_id (set null),
  // making the posted charges impossible to unpost — and clear the dedup
  // hash, so re-uploading the same statement could double-charge tenants.
  if (bill?.overage_charged_at)
    return {
      error:
        "This bill's overage is charged to tenants — unpost it before deleting the bill.",
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (sb as any).from("utility_bills").delete().eq("id", billId);
  if (error) return { error: error.message };
  if (bill?.statement_path) {
    await sb.storage.from("utilities").remove([bill.statement_path]);
  }
  revalidatePath("/utilities");
  return { success: "Bill deleted." };
}

// Dismiss (or restore) a bill's over-$200 flag in the banner. The badge on
// the bill card itself is not affected.
export async function dismissOverage(
  billIds: string[],
  dismissed: boolean,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (billIds.length === 0) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("utility_bills")
    .update({ overage_dismissed: dismissed })
    .in("id", billIds);
  if (error) return { error: error.message };
  revalidatePath("/utilities");
  return undefined;
}

// ----- Charge the over-$200 overage to the unit's tenants -----
//
// Lease clause: usage charges (incl. tax, excl. late fees) over $200/month
// are billable to the occupants. The overage is prorated per billed day and
// split, day by day, among the tenants living in the unit's AC rooms that
// day. Every occupant gets a ledger charge (kind 'utility_overage') —
// including tenants who have since moved out; their share additionally
// raises an alert popup on the Rent Tracker so the operator remembers to
// collect it (e.g. against the deposit).

/** Per-bill outcome of a charge run, rendered in the results popup. */
export type OverageChargeResult = {
  billId: string;
  unit: string;
  period: string;
  /** null when the bill was charged; otherwise why it was skipped. */
  error: string | null;
  charged: { name: string; amount: number }[];
  /** Also charged, but moved out — additionally flagged on the Rent Tracker. */
  movedOut: { name: string; amount: number }[];
  /** Overage dollars falling on days no eligible tenant was living there. */
  uncovered: number;
  /** Charged occupants emailed a "pay it with next month's rent" notice. */
  notified?: number;
};

type SessionClient = Awaited<ReturnType<typeof createClient>>;

/** One occupant's computed slice of a bill's overage. */
type SplitEntry = {
  tenancyId: string;
  name: string;
  cents: number;
  movedOut: boolean;
  /** Billed days they lived in an AC room, and the first/last such date. */
  days: number;
  firstDay: string;
  lastDay: string;
};

type SplitOutcome =
  | { ok: false; result: OverageChargeResult }
  | {
      ok: true;
      result: OverageChargeResult; // unit/period metadata filled in
      bill: BillRow;
      overageCents: number;
      unassigned: number;
      periodDays: number;
      entries: SplitEntry[];
    };

/**
 * Computes the per-tenant split of a bill's overage (per-day proration among
 * AC-room occupants) without posting anything — shared by the preview popup
 * and the charge run itself.
 */
async function computeOverageSplit(
  sb: SessionClient,
  billId: string,
): Promise<SplitOutcome> {
  const result: OverageChargeResult = {
    billId,
    unit: "⚠ Unmatched unit",
    period: "—",
    error: null,
    charged: [],
    movedOut: [],
    uncovered: 0,
  };
  const fail = (error: string): SplitOutcome => ({
    ok: false,
    result: { ...result, error },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error: billErr } = await (sb as any)
    .from("utility_bills")
    .select("*, utility_bill_charges(id, kind, description, amount)")
    .eq("id", billId)
    .maybeSingle();
  if (billErr) return fail(billErr.message);
  if (!bill) return fail("Bill not found.");
  const b = bill as BillRow & { overage_charged_at: string | null };

  result.period = `${monthLabel(billMonth(b))} · ${b.utility_type}${b.provider ? ` (${b.provider})` : ""}`;
  if (b.property_id) {
    const { data: p } = await sb
      .from("properties")
      .select("building_name, street_address, unit_number")
      .eq("id", b.property_id)
      .maybeSingle();
    if (p)
      result.unit = `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`;
  }

  if (b.overage_charged_at)
    return fail("This bill's overage has already been charged.");
  if (!b.property_id)
    return fail("Assign the bill to a unit before charging tenants.");
  if (!isOverThreshold(b))
    return fail("This bill's usage is not over the $200 threshold.");
  if (!b.period_start || !b.period_end || b.period_end < b.period_start)
    return fail(
      "The bill has no billing period on file — the overage can't be prorated per day.",
    );

  // Money math in integer cents; usage is a float sum of numeric strings.
  const overageCents =
    Math.round(usageTotal(b) * 100) - OVERAGE_THRESHOLD * 100;
  if (overageCents <= 0)
    return fail("This bill's usage is not over the $200 threshold.");
  const overage = overageCents / 100;

  // The period end is exclusive: statements bill start..(end - 1) and the
  // end date is the next cycle's start (verified against the uploaded
  // ConEd/PSE&G statements). Walking it inclusively would bill the boundary
  // day under two consecutive statements. Same-day periods count as 1 day.
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = Date.parse(`${b.period_start.slice(0, 10)}T00:00:00Z`);
  const endMs = Math.max(
    startMs + dayMs,
    Date.parse(`${b.period_end.slice(0, 10)}T00:00:00Z`),
  );
  const days = Math.round((endMs - startMs) / dayMs);
  const perDay = overage / days;

  // Occupants: tenancies in this unit's AC rooms. Rooms without AC don't
  // share the overage.
  const { data: rooms } = await sb
    .from("rooms")
    .select("id, has_ac")
    .eq("property_id", b.property_id);
  const acRoomIds = (rooms ?? []).filter((r) => r.has_ac).map((r) => r.id);
  if (acRoomIds.length === 0)
    return fail("No rooms in this unit are marked as having AC.");

  const { data: tenancies, error: tErr } = await sb
    .from("tenancies")
    .select("id, start_date, move_out_date, status, tenants(full_name)")
    .in("room_id", acRoomIds);
  if (tErr) return fail(tErr.message);

  // Walk the billed days ([start, end) exclusive): each day's slice of the
  // overage is split equally among the tenants living in an AC room that day.
  // Alongside the dollar shares, track each tenant's covered days and date
  // range for the charge-preview popup.
  const shares = new Map<string, number>();
  const dayStats = new Map<
    string,
    { days: number; firstDay: string; lastDay: string }
  >();
  let unassigned = 0;
  for (let ms = startMs; ms < endMs; ms += dayMs) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const living = (tenancies ?? []).filter(
      (t) =>
        t.start_date <= day && (!t.move_out_date || t.move_out_date >= day),
    );
    if (living.length === 0) {
      unassigned += perDay;
      continue;
    }
    for (const t of living) {
      shares.set(t.id, (shares.get(t.id) ?? 0) + perDay / living.length);
      const s = dayStats.get(t.id);
      if (s) {
        s.days += 1;
        s.lastDay = day;
      } else {
        dayStats.set(t.id, { days: 1, firstDay: day, lastDay: day });
      }
    }
  }
  if (shares.size === 0)
    return fail(
      "No tenants were living in this unit's AC rooms during the billing period.",
    );

  // Largest-remainder rounding: per-tenancy cents that sum exactly to the
  // assigned overage (overage minus vacant-day remainder) — independent
  // rounding can gain or lose a cent per tenant.
  const assignedCents = overageCents - Math.round(unassigned * 100);
  const rounded = [...shares.entries()].map(([tenancyId, raw]) => {
    const cents = raw * 100;
    return { tenancyId, cents: Math.floor(cents + 1e-6), frac: cents % 1 };
  });
  let leftover = assignedCents - rounded.reduce((s, r) => s + r.cents, 0);
  rounded.sort((a, b) => b.frac - a.frac);
  for (let i = 0; leftover > 0 && rounded.length > 0; i = (i + 1) % rounded.length) {
    rounded[i].cents += 1;
    leftover -= 1;
  }

  const today = todayISO();
  const entries: SplitEntry[] = rounded.map(({ tenancyId, cents }) => {
    const t = (tenancies ?? []).find((x) => x.id === tenancyId)!;
    const stats = dayStats.get(tenancyId)!;
    return {
      tenancyId,
      name: one(t.tenants)?.full_name ?? "Tenant",
      cents,
      movedOut:
        t.status === "ended" || (!!t.move_out_date && t.move_out_date < today),
      days: stats.days,
      firstDay: stats.firstDay,
      lastDay: stats.lastDay,
    };
  });

  return {
    ok: true,
    result,
    bill: b,
    overageCents,
    unassigned,
    periodDays: days,
    entries,
  };
}

async function chargeOverageCore(
  sb: SessionClient,
  billId: string,
  /** Operator-edited shares from the preview popup, matched by tenancy. */
  editedShares?: { tenancyId: string; amount: number }[],
): Promise<OverageChargeResult> {
  const split = await computeOverageSplit(sb, billId);
  if (!split.ok) return split.result;
  const { result, bill: b, unassigned } = split;
  const fail = (error: string) => ({ ...result, error });

  let entries = split.entries;
  if (editedShares) {
    const byId = new Map(editedShares.map((s) => [s.tenancyId, s.amount]));
    for (const s of editedShares) {
      if (!Number.isFinite(s.amount) || s.amount < 0)
        return fail("Each share must be a non-negative amount.");
      if (!entries.some((e) => e.tenancyId === s.tenancyId))
        return fail("A share was submitted for a tenant not on this bill.");
    }
    entries = entries.map((e) => {
      const amount = byId.get(e.tenancyId);
      return amount === undefined
        ? e
        : { ...e, cents: Math.round(amount * 100) };
    });
  }

  // A $0 share (rounded to nothing, or zeroed by the operator) isn't posted.
  const charged = entries
    .filter((e) => !e.movedOut && e.cents > 0)
    .map((e) => ({ tenancyId: e.tenancyId, name: e.name, amount: e.cents / 100 }));
  const movedOut = entries
    .filter((e) => e.movedOut && e.cents > 0)
    .map((e) => ({ tenancyId: e.tenancyId, name: e.name, amount: e.cents / 100 }));
  if (charged.length === 0 && movedOut.length === 0)
    return fail("Every share is $0 — nothing to charge.");

  const today = todayISO();

  // Claim the bill FIRST with a compare-and-set, so a concurrent charge of
  // the same bill (double click, second session, overlapping Charge All)
  // loses the race here instead of double-billing the tenants. The partial
  // unique index tenancy_charges_overage_once is the DB-level backstop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimed, error: claimErr } = await (sb as any)
    .from("utility_bills")
    .update({
      overage_charged_at: new Date().toISOString(),
      overage_dismissed: true,
    })
    .eq("id", b.id)
    .is("overage_charged_at", null)
    .select("id");
  if (claimErr) return fail(claimErr.message);
  if (!claimed || claimed.length === 0)
    return fail("This bill's overage has already been charged.");

  // If a later write fails, put the bill back exactly as it was.
  const releaseClaim = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb as any)
      .from("utility_bills")
      .update({
        overage_charged_at: null,
        overage_dismissed: b.overage_dismissed,
      })
      .eq("id", b.id);
  };

  // Everyone with a share gets the ledger charge — moved-out tenants
  // included; their ended tenancy's ledger carries the balance.
  const allCharged = [...charged, ...movedOut];
  if (allCharged.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb as any).from("tenancy_charges").insert(
      allCharged.map((c) => ({
        tenancy_id: c.tenancyId,
        kind: "utility_overage",
        amount: c.amount,
        charged_on: today,
        note: result.period,
        bill_id: b.id,
      })),
    );
    if (error) {
      await releaseClaim();
      return fail(error.message);
    }
  }

  if (movedOut.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb as any).from("utility_overage_alerts").insert(
      movedOut.map((m) => ({
        bill_id: b.id,
        tenancy_id: m.tenancyId,
        tenant_name: m.name,
        unit_label: result.unit,
        amount: m.amount,
        period_label: result.period,
      })),
    );
    if (error) {
      // Roll the whole run back: charges out, claim released.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any)
        .from("tenancy_charges")
        .delete()
        .eq("bill_id", b.id)
        .eq("kind", "utility_overage");
      await releaseClaim();
      return fail(error.message);
    }
  }

  result.charged = charged.map(({ name, amount }) => ({ name, amount }));
  result.movedOut = movedOut.map(({ name, amount }) => ({ name, amount }));
  result.uncovered = Math.round(unassigned * 100) / 100;

  // Tell each charged current occupant right away, asking them to add the
  // share to next month's rent. Best-effort: a notification failure never
  // blocks (or rolls back) the charge itself. Moved-out tenants aren't
  // emailed — their share surfaces as an operator alert instead.
  try {
    result.notified = await notifyOverageCharged(sb, b, result, charged);
  } catch (e) {
    console.error("[utilities] overage notices failed:", e);
  }

  return result;
}

/** Email every charged occupant their share; returns how many were sent. */
async function notifyOverageCharged(
  sb: SessionClient,
  bill: BillRow,
  result: OverageChargeResult,
  charged: { tenancyId: string; name: string; amount: number }[],
): Promise<number> {
  if (charged.length === 0) return 0;

  type NoticeRow = {
    id: string;
    tenants: { email: string | null } | { email: string | null }[] | null;
    rooms:
      | { properties: { is_new_york: boolean } | { is_new_york: boolean }[] | null }
      | { properties: { is_new_york: boolean } | { is_new_york: boolean }[] | null }[]
      | null;
  };
  const { data: tenancyRows } = await sb
    .from("tenancies")
    .select("id, tenants(email), rooms(properties(is_new_york))")
    .in(
      "id",
      charged.map((c) => c.tenancyId),
    )
    .returns<NoticeRow[]>();
  const rowById = new Map((tenancyRows ?? []).map((r) => [r.id, r]));

  // One signed statement link shared by every notice (30 days, same TTL as
  // the balance-reminder links).
  let statementUrl: string | null = null;
  const path = (bill as BillRow & { statement_path?: string | null })
    .statement_path;
  if (path) {
    const { data: signed } = await sb.storage
      .from("utilities")
      .createSignedUrl(path, 60 * 60 * 24 * 30);
    statementUrl = signed?.signedUrl ?? null;
  }

  // "Include it with your <August> rent" — the month after today.
  const [y, m] = todayISO().slice(0, 7).split("-").map(Number);
  const nextMonthLabel = new Date(Date.UTC(y, m, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });

  let sent = 0;
  for (const c of charged) {
    const row = rowById.get(c.tenancyId);
    const email = one(row?.tenants ?? null)?.email?.trim();
    if (!email) continue;
    const isNewYork =
      one(one(row?.rooms ?? null)?.properties ?? null)?.is_new_york ?? false;
    const notice = {
      amount: c.amount,
      period: result.period,
      unitLabel: result.unit,
      nextMonthLabel,
      statementUrl,
    };
    const res = isNewYork
      ? await sendUtilityChargeNoticeGmail(email, notice)
      : await sendUtilityChargeNotice(email, notice);
    if (res.ok) sent++;
  }
  return sent;
}

const deniedResult = (billId: string, error: string): OverageChargeResult => ({
  billId,
  unit: "—",
  period: "—",
  error,
  charged: [],
  movedOut: [],
  uncovered: 0,
});

/** One row of the charge-preview popup: a tenant, their stay, their share. */
export type OveragePreviewTenant = {
  tenancyId: string;
  name: string;
  /** Computed share in dollars — the popup's editable starting value. */
  amount: number;
  movedOut: boolean;
  /** Billed days they lived in an AC room, and the first/last such date. */
  days: number;
  firstDay: string;
  lastDay: string;
};

export type OveragePreview = {
  billId: string;
  unit: string;
  period: string;
  /** Statement billing period (raw dates; end is the cycle boundary). */
  periodStart: string | null;
  periodEnd: string | null;
  periodDays: number;
  overage: number;
  /** Overage dollars falling on days no eligible tenant was living there. */
  uncovered: number;
  error: string | null;
  tenants: OveragePreviewTenant[];
};

/**
 * Dry-run of a bill's overage split for the charge-preview popup: who would
 * be charged what, over which days. Posts nothing.
 */
export async function previewOverage(billId: string): Promise<OveragePreview> {
  const empty: OveragePreview = {
    billId,
    unit: "—",
    period: "—",
    periodStart: null,
    periodEnd: null,
    periodDays: 0,
    overage: 0,
    uncovered: 0,
    error: null,
    tenants: [],
  };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ...empty, error: "Not signed in." };
  if (!canEditLedger(user.email)) return { ...empty, error: LEDGER_ADMIN_ERROR };

  const split = await computeOverageSplit(supabase, billId);
  if (!split.ok)
    return {
      ...empty,
      unit: split.result.unit,
      period: split.result.period,
      error: split.result.error,
    };

  return {
    billId,
    unit: split.result.unit,
    period: split.result.period,
    periodStart: split.bill.period_start,
    periodEnd: split.bill.period_end,
    periodDays: split.periodDays,
    overage: split.overageCents / 100,
    uncovered: Math.round(split.unassigned * 100) / 100,
    error: null,
    tenants: split.entries.map((e) => ({
      tenancyId: e.tenancyId,
      name: e.name,
      amount: e.cents / 100,
      movedOut: e.movedOut,
      days: e.days,
      firstDay: e.firstDay,
      lastDay: e.lastDay,
    })),
  };
}

export async function chargeOverage(
  billId: string,
  /** Operator-edited shares from the preview popup; omit to use the split. */
  shares?: { tenancyId: string; amount: number }[],
): Promise<OverageChargeResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return deniedResult(billId, "Not signed in.");
  if (!canEditLedger(user.email))
    return deniedResult(billId, LEDGER_ADMIN_ERROR);

  const result = await chargeOverageCore(supabase, billId, shares);
  revalidatePath("/utilities");
  revalidatePath("/tenants");
  return result;
}

/**
 * Charge every flagged bill in one go. Each bill is processed independently
 * — one bill failing validation (no unit, no billing period…) doesn't stop
 * the others — and the per-bill outcomes are returned together for the
 * results popup.
 */
export async function chargeAllOverages(
  billIds: string[],
): Promise<OverageChargeResult[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return billIds.map((id) => deniedResult(id, "Not signed in."));
  if (!canEditLedger(user.email))
    return billIds.map((id) => deniedResult(id, LEDGER_ADMIN_ERROR));

  const sb = supabase;
  const results: OverageChargeResult[] = [];
  for (const id of billIds) {
    results.push(await chargeOverageCore(sb, id));
  }
  revalidatePath("/utilities");
  revalidatePath("/tenants");
  return results;
}

/**
 * Reverse a bill's overage charge run: delete the 'Utility Overcharge'
 * ledger charges it posted, clear its moved-out Rent Tracker alerts, and
 * reopen the bill so it can be flagged/charged again.
 */
export async function unpostOverage(billId: string): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const sb = supabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill } = await (sb as any)
    .from("utility_bills")
    .select("id, overage_charged_at")
    .eq("id", billId)
    .maybeSingle();
  if (!bill) return { error: "Bill not found." };
  if (!bill.overage_charged_at)
    return { error: "This bill's overage hasn't been charged." };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: chErr } = await (sb as any)
    .from("tenancy_charges")
    .delete()
    .eq("bill_id", billId)
    .eq("kind", "utility_overage");
  if (chErr) return { error: chErr.message };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (sb as any).from("utility_overage_alerts").delete().eq("bill_id", billId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: billErr } = await (sb as any)
    .from("utility_bills")
    .update({ overage_charged_at: null, overage_dismissed: false })
    .eq("id", billId);
  if (billErr) return { error: billErr.message };

  revalidatePath("/utilities");
  revalidatePath("/tenants");
  return {
    success:
      "Charge unposted — the ledger charges and any Rent Tracker alerts were removed, and the bill is flagged again.",
  };
}

export async function getStatementUrl(
  billId: string,
): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  // Session client so the read and signed URL honor RLS if it's ever
  // tightened per-property.
  const sb = supabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error } = await (sb as any)
    .from("utility_bills")
    .select("statement_path")
    .eq("id", billId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!bill?.statement_path) return { error: "No statement on file." };
  const { data, error: signErr } = await sb.storage
    .from("utilities")
    .createSignedUrl(bill.statement_path, 300);
  if (signErr) return { error: signErr.message };
  return { url: data.signedUrl };
}
