"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isValid, zUuid, zUuidArray } from "@/lib/validation";
import { getSessionUser } from "@/lib/session";
import { extractUtilityBill, type UnitOption } from "@/lib/utility-extract";
import { compressStatement } from "@/lib/compress-statement";
import {
  findHashDuplicate,
  hintKeys,
  ingestBill,
  loadUnits,
} from "@/lib/utility-ingest";
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

export async function uploadStatement(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
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

  let units: UnitOption[];
  try {
    units = await loadUnits(sb);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to load units." };
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // Checked before extraction so a re-drop doesn't burn an extraction call.
  const fileHash = createHash("sha256").update(buf).digest("hex");
  const hashDup = await findHashDuplicate(sb, fileHash);
  if (hashDup) return { error: hashDup };

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

  const res = await ingestBill(sb, {
    buf,
    fileName: file.name,
    mediaType,
    fileHash,
    extracted,
    units,
  });
  if (!res.ok) return { error: res.error };

  revalidatePath("/utilities");
  const extras = res.extracted.charges.filter((c) => c.kind !== "current");
  const parts = [
    `Logged $${res.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    res.extracted.provider ?? "utility",
    res.unit ? `for ${res.unit.label}` : "",
    res.learned ? "(matched from your earlier manual assignment)" : "",
    extras.length
      ? `(${extras.length} late-fee/other charge${extras.length === 1 ? "" : "s"} saved separately)`
      : "",
  ].filter(Boolean);
  return {
    success: parts.join(" "),
    warning: !res.extracted.property_id
      ? "Couldn't match the service address to a unit — assign it in the log below."
      : undefined,
  };
}

// ----------------------------------------------------------------------------
// Manual bill entry — commitManualBills saves rows the operator typed in
// themselves. The attached screenshot is never read or extracted; it is
// stored once and shared as the statement of every bill it produced (and its
// hash blocks re-uploading the same file).
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
const MAX_MANUAL_FILES = 5;

const ManualChargeSchema = z.object({
  kind: z.enum(["current", "late_fee", "other"]),
  description: z.string(),
  amount: z.number().finite(),
});
type ManualCharge = z.infer<typeof ManualChargeSchema>;

function screenshotProblem(file: File): string | null {
  if (file.size > MAX_STATEMENT_BYTES)
    return "Screenshot must be 20 MB or smaller.";
  const mediaType = file.type || "application/octet-stream";
  if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(mediaType))
    return "Screenshot must be a PDF or a PNG/JPEG/WebP image.";
  return null;
}

export async function commitManualBills(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };

  const propertyId = String(formData.get("property_id") ?? "");
  const utilityType = String(formData.get("utility_type") ?? "");

  if (!propertyId) return { error: "Pick the unit." };
  if (!isValid(zUuid, propertyId)) return { error: "Invalid unit id." };
  if (!MANUAL_TYPES.has(utilityType))
    return { error: "Pick the utility type." };
  // Screenshots are optional, up to MAX_MANUAL_FILES per entry. The first
  // becomes the bill's statement; the rest are stored as extra attachments.
  const screenshots = formData
    .getAll("screenshot")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (screenshots.length > MAX_MANUAL_FILES)
    return { error: `At most ${MAX_MANUAL_FILES} screenshots per entry.` };
  for (const s of screenshots) {
    const problem = screenshotProblem(s);
    if (problem) return { error: `${s.name}: ${problem}` };
  }

  const rowIds = String(formData.get("row_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (rowIds.length === 0) return { error: "Add at least one billing cycle." };
  if (rowIds.length > MAX_MANUAL_CYCLES)
    return { error: `At most ${MAX_MANUAL_CYCLES} cycles per entry.` };

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
        charges = parsed
          .map((c) => ManualChargeSchema.safeParse(c))
          .filter((r) => r.success)
          .map((r) => r.data);
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
    const { data: candidates } = await supabase
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

  // Store the screenshots (when attached): hash each so re-uploading the
  // same file is caught — against both the bills' statement hashes and the
  // attachments table — then compress and upload. The first file is every
  // bill's statement; the rest become attachment rows.
  type StoredFile = { path: string; hash: string; name: string };
  const stored: StoredFile[] = [];
  const removeStored = async () => {
    if (stored.length > 0)
      await supabase.storage
        .from("utilities")
        .remove(stored.map((s) => s.path));
  };
  if (screenshots.length > 0) {
    const bufs = await Promise.all(
      screenshots.map(async (s) => Buffer.from(await s.arrayBuffer())),
    );
    const hashes = bufs.map((b) =>
      createHash("sha256").update(b).digest("hex"),
    );
    if (new Set(hashes).size !== hashes.length)
      return { error: "The same file is attached twice — remove one." };
    const [{ data: dupBills }, { data: dupFiles }] = await Promise.all([
      supabase.from("utility_bills").select("id").in("file_sha256", hashes),
      supabase
        .from("utility_bill_files")
        .select("id")
        .in("file_sha256", hashes),
    ]);
    if ((dupBills?.length ?? 0) > 0 || (dupFiles?.length ?? 0) > 0)
      return {
        error:
          "Duplicate — one of these files is already attached to a logged bill.",
      };

    for (let i = 0; i < screenshots.length; i++) {
      const s = screenshots[i];
      const mediaType = s.type || "application/pdf";
      const compressed = await compressStatement(bufs[i], mediaType);
      let safeName = s.name.replace(/[^\w.\-]/g, "_") || "screenshot";
      if (compressed.mediaType === "image/webp" && !/\.webp$/i.test(safeName)) {
        safeName = safeName.replace(/\.[a-z0-9]+$/i, "") + ".webp";
      }
      const path = `${propertyId}/${Date.now()}-manual-${i}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("utilities")
        .upload(path, compressed.data, {
          contentType: compressed.mediaType,
          upsert: false,
        });
      if (upErr) {
        await removeStored();
        return { error: `Failed to store ${s.name}: ${upErr.message}` };
      }
      stored.push({ path, hash: hashes[i], name: s.name });
    }
  }
  const path = stored[0]?.path ?? null;
  const fileHash = stored[0]?.hash ?? null;

  const provider = String(formData.get("provider") ?? "").trim() || null;
  const notes = "Entered manually.";

  const insertedBillIds: string[] = [];
  const rollback = async () => {
    if (insertedBillIds.length > 0) {
      // Attachment rows cascade with the bills.
      await supabase
        .from("utility_bills")
        .delete()
        .in("id", insertedBillIds);
    }
    await removeStored();
  };

  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    const { data: bill, error: insErr } = await supabase
      .from("utility_bills")
      .insert({
        property_id: propertyId,
        provider,
        utility_type: utilityType,
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

    if (stored.length > 1) {
      const { error: filesErr } = await supabase
        .from("utility_bill_files")
        .insert(
          stored.slice(1).map((s, idx) => ({
            bill_id: bill.id,
            file_path: s.path,
            file_name: s.name,
            file_sha256: s.hash,
            sort_order: idx + 1,
          })),
        );
      if (filesErr) {
        await rollback();
        return { error: `Failed to save attachments: ${filesErr.message}` };
      }
    }

    // A charges breakdown (late fees separated for the over-$200 split) is
    // honored only when it agrees with the entered amount to the cent.
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
    const { error: chErr } = await supabase
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

/**
 * Attach statement/screenshot files to an already-logged bill (typically a
 * manual entry saved without one). The first file fills the empty statement
 * slot; the rest — or all of them, if the bill already has a statement —
 * become extra attachment rows. Nothing is read or extracted, and no tenant
 * email fires here: overage notices go out only when the charge is posted,
 * so a late attachment never re-notifies anyone.
 */
export async function attachBillFiles(
  billId: string,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, billId)) return { error: "Invalid bill id." };

  const files = formData
    .getAll("screenshot")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { error: "Pick a file to attach." };
  for (const f of files) {
    const problem = screenshotProblem(f);
    if (problem) return { error: `${f.name}: ${problem}` };
  }

  const { data: bill } = await supabase
    .from("utility_bills")
    .select(
      "id, property_id, statement_path, file_sha256, utility_bill_files(id, sort_order)",
    )
    .eq("id", billId)
    .maybeSingle();
  if (!bill) return { error: "Bill not found." };

  const existingCount =
    (bill.statement_path ? 1 : 0) + (bill.utility_bill_files?.length ?? 0);
  if (existingCount + files.length > MAX_MANUAL_FILES)
    return {
      error:
        `At most ${MAX_MANUAL_FILES} files per bill — ` +
        `${existingCount} already attached.`,
    };

  // Same dedup as manual entry: hash each file and refuse anything already
  // attached to any logged bill (statement hashes + attachment rows).
  const bufs = await Promise.all(
    files.map(async (f) => Buffer.from(await f.arrayBuffer())),
  );
  const hashes = bufs.map((b) => createHash("sha256").update(b).digest("hex"));
  if (new Set(hashes).size !== hashes.length)
    return { error: "The same file is attached twice — remove one." };
  const [{ data: dupBills }, { data: dupFiles }] = await Promise.all([
    supabase.from("utility_bills").select("id").in("file_sha256", hashes),
    supabase.from("utility_bill_files").select("id").in("file_sha256", hashes),
  ]);
  if ((dupBills?.length ?? 0) > 0 || (dupFiles?.length ?? 0) > 0)
    return {
      error:
        "Duplicate — one of these files is already attached to a logged bill.",
    };

  type StoredFile = { path: string; hash: string; name: string };
  const stored: StoredFile[] = [];
  const removeStored = async () => {
    if (stored.length > 0)
      await supabase.storage
        .from("utilities")
        .remove(stored.map((s) => s.path));
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const mediaType = f.type || "application/pdf";
    const compressed = await compressStatement(bufs[i], mediaType);
    let safeName = f.name.replace(/[^\w.\-]/g, "_") || "screenshot";
    if (compressed.mediaType === "image/webp" && !/\.webp$/i.test(safeName)) {
      safeName = safeName.replace(/\.[a-z0-9]+$/i, "") + ".webp";
    }
    const path = `${bill.property_id ?? "unmatched"}/${Date.now()}-attach-${i}-${safeName}`;
    const { error: upErr } = await supabase.storage
      .from("utilities")
      .upload(path, compressed.data, {
        contentType: compressed.mediaType,
        upsert: false,
      });
    if (upErr) {
      await removeStored();
      return { error: `Failed to store ${f.name}: ${upErr.message}` };
    }
    stored.push({ path, hash: hashes[i], name: f.name });
  }

  let rest = stored;
  let statementSet = false;
  if (!bill.statement_path) {
    const [first, ...others] = stored;
    const { error } = await supabase
      .from("utility_bills")
      .update({
        statement_path: first.path,
        file_sha256: bill.file_sha256 ?? first.hash,
      })
      .eq("id", billId);
    if (error) {
      await removeStored();
      return { error: error.message };
    }
    statementSet = true;
    rest = others;
  }

  if (rest.length > 0) {
    const nextOrder =
      Math.max(0, ...(bill.utility_bill_files ?? []).map((f) => f.sort_order)) +
      1;
    const { error } = await supabase.from("utility_bill_files").insert(
      rest.map((s, idx) => ({
        bill_id: billId,
        file_path: s.path,
        file_name: s.name,
        file_sha256: s.hash,
        sort_order: nextOrder + idx,
      })),
    );
    if (error) {
      if (statementSet)
        await supabase
          .from("utility_bills")
          .update({ statement_path: null, file_sha256: bill.file_sha256 })
          .eq("id", billId);
      await removeStored();
      return { error: `Failed to save attachments: ${error.message}` };
    }
  }

  revalidatePath("/utilities");
  return {
    success:
      files.length === 1 ? "File attached." : `${files.length} files attached.`,
  };
}

export async function assignBillProperty(
  billId: string,
  propertyId: string | null,
): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, billId) || !isValid(zUuid.nullable(), propertyId))
    return { error: "Invalid bill or unit id." };

  const sb = supabase;
  // A charged bill's ledger charges belong to the current unit's tenants —
  // reassigning it would silently misattribute them.
  const { data: existing } = await sb
    .from("utility_bills")
    .select("overage_charged_at")
    .eq("id", billId)
    .maybeSingle();
  if (existing?.overage_charged_at)
    return {
      error:
        "This bill's overage is charged to tenants — unpost it before reassigning the unit.",
    };
  const { data: bill, error } = await sb
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
      await sb.from("utility_unit_hints").upsert(
        keys.map((key) => ({ key, property_id: propertyId })),
        { onConflict: "key" },
      );
    } else {
      // Un-assigning means the learned mapping was wrong — forget it.
      await sb.from("utility_unit_hints").delete().in("key", keys);
    }
  }
  revalidatePath("/utilities");
  return { success: "Bill reassigned." };
}

export async function deleteBill(billId: string): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, billId)) return { error: "Invalid bill id." };

  const sb = supabase;
  const { data: bill } = await sb
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
  const { data: fileRows } = await sb
    .from("utility_bill_files")
    .select("file_path")
    .eq("bill_id", billId);
  const paths = [
    ...(bill?.statement_path ? [bill.statement_path] : []),
    ...(fileRows ?? []).map((f) => f.file_path),
  ];

  const { error } = await sb.from("utility_bills").delete().eq("id", billId);
  if (error) return { error: error.message };

  // A multi-cycle submission shares its files across sibling bills — only
  // remove storage objects that no remaining bill references.
  if (paths.length > 0) {
    const [{ data: stillBills }, { data: stillFiles }] = await Promise.all([
      sb
        .from("utility_bills")
        .select("statement_path")
        .in("statement_path", paths),
      sb.from("utility_bill_files").select("file_path").in("file_path", paths),
    ]);
    const still = new Set([
      ...(stillBills ?? []).map((b) => b.statement_path),
      ...(stillFiles ?? []).map((f) => f.file_path),
    ]);
    const orphaned = paths.filter((p) => !still.has(p));
    if (orphaned.length > 0) {
      await sb.storage.from("utilities").remove(orphaned);
    }
  }
  revalidatePath("/utilities");
  return { success: "Bill deleted." };
}

/** Signed URL for one of a bill's extra attachments (utility_bill_files). */
export async function getBillFileUrl(
  fileId: string,
): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!isValid(zUuid, fileId)) return { error: "Invalid file id." };

  const { data: row, error } = await supabase
    .from("utility_bill_files")
    .select("file_path")
    .eq("id", fileId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!row) return { error: "Attachment not found." };
  const { data, error: signErr } = await supabase.storage
    .from("utilities")
    .createSignedUrl(row.file_path, 300);
  if (signErr) return { error: signErr.message };
  return { url: data.signedUrl };
}

// Dismiss (or restore) a bill's over-$200 flag in the banner. The badge on
// the bill card itself is not affected.
export async function dismissOverage(
  billIds: string[],
  dismissed: boolean,
): Promise<UploadState> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuidArray, billIds)) return { error: "Invalid bill ids." };
  if (billIds.length === 0) return undefined;

  const { error } = await supabase
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

  const { data: bill, error: billErr } = await sb
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
  const { data: claimed, error: claimErr } = await sb
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
    await sb
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
    const { error } = await sb.from("tenancy_charges").insert(
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
    const { error } = await sb.from("utility_overage_alerts").insert(
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
      await sb
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
  const user = await getSessionUser();
  if (!user) return { ...empty, error: "Not signed in." };
  if (!canEditLedger(user.email)) return { ...empty, error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, billId)) return { ...empty, error: "Invalid bill id." };

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

const SharesSchema = z
  .array(z.object({ tenancyId: z.uuid(), amount: z.number().nonnegative() }))
  .optional();

export async function chargeOverage(
  billId: string,
  /** Operator-edited shares from the preview popup; omit to use the split. */
  shares?: { tenancyId: string; amount: number }[],
): Promise<OverageChargeResult> {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return deniedResult(billId, "Not signed in.");
  if (!canEditLedger(user.email))
    return deniedResult(billId, LEDGER_ADMIN_ERROR);
  if (!isValid(zUuid, billId) || !isValid(SharesSchema, shares))
    return deniedResult(billId, "Invalid charge input.");

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
  const user = await getSessionUser();
  if (!user) return billIds.map((id) => deniedResult(id, "Not signed in."));
  if (!canEditLedger(user.email))
    return billIds.map((id) => deniedResult(id, LEDGER_ADMIN_ERROR));
  if (!isValid(zUuidArray, billIds))
    return billIds.map((id) => deniedResult(id, "Invalid bill id."));

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
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!canEditLedger(user.email)) return { error: LEDGER_ADMIN_ERROR };
  if (!isValid(zUuid, billId)) return { error: "Invalid bill id." };

  const sb = supabase;
  const { data: bill } = await sb
    .from("utility_bills")
    .select("id, overage_charged_at")
    .eq("id", billId)
    .maybeSingle();
  if (!bill) return { error: "Bill not found." };
  if (!bill.overage_charged_at)
    return { error: "This bill's overage hasn't been charged." };

  const { error: chErr } = await sb
    .from("tenancy_charges")
    .delete()
    .eq("bill_id", billId)
    .eq("kind", "utility_overage");
  if (chErr) return { error: chErr.message };

  await sb.from("utility_overage_alerts").delete().eq("bill_id", billId);

  const { error: billErr } = await sb
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
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!isValid(zUuid, billId)) return { error: "Invalid bill id." };

  // Session client so the read and signed URL honor RLS if it's ever
  // tightened per-property.
  const sb = supabase;
  const { data: bill, error } = await sb
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
