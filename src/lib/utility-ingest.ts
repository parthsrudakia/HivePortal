/**
 * Shared save path for utility statements. Whoever produced the structured
 * bill — Claude (`extractUtilityBill`, portal upload) or an external agent
 * (`POST /api/utilities/statements`) — it lands in the log through
 * `ingestBill`, so both paths get the same unit-hint override, duplicate
 * guards, compression, and insert-or-clean-up behavior.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { ExtractedBill, UnitOption } from "@/lib/utility-extract";
import { compressStatement } from "@/lib/compress-statement";

type Sb = SupabaseClient<Database>;

export const STATEMENT_SOURCES = ["pseg", "coned", "other"] as const;
export type StatementSource = (typeof STATEMENT_SOURCES)[number];

/** Canonical provider name per source, so the log reads the same whoever
 *  typed the provider. */
export const SOURCE_PROVIDER: Partial<Record<StatementSource, string>> = {
  pseg: "PSE&G",
  coned: "Con Edison",
};

// Normalized hint keys for the learned statement→unit mappings.
export function hintKeys(bill: {
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

/** Every unit, for address matching. */
export async function loadUnits(sb: Sb): Promise<UnitOption[]> {
  const { data: props, error } = await sb
    .from("properties")
    .select("id, building_name, street_address, unit_number");
  if (error) throw new Error(`Failed to load units: ${error.message}`);
  return (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
    street_address: p.street_address,
    unit_number: p.unit_number,
  }));
}

/**
 * Duplicate guard 1: the exact same file is already stored — either as a
 * bill's primary statement or as an extra attachment on a bill. Returns a
 * user-facing message, or null. Run before any extraction so a re-drop
 * doesn't burn a model call.
 */
export async function findHashDuplicate(
  sb: Sb,
  fileHash: string,
): Promise<string | null> {
  const { data: dup } = await sb
    .from("utility_bills")
    .select("id, provider, statement_date")
    .eq("file_sha256", fileHash)
    .maybeSingle();
  if (dup) {
    const what = [dup.provider, dup.statement_date && `statement ${dup.statement_date}`]
      .filter(Boolean)
      .join(", ");
    return `Duplicate — this exact file is already in the log${what ? ` (${what})` : ""}. Discarded.`;
  }
  const { data: att } = await sb
    .from("utility_bill_files")
    .select("id")
    .eq("file_sha256", fileHash)
    .limit(1)
    .maybeSingle();
  if (att) {
    return "Duplicate — this exact file is already attached to a bill in the log. Discarded.";
  }
  return null;
}

export type IngestResult =
  | {
      ok: true;
      billId: string;
      total: number;
      unit: UnitOption | undefined;
      learned: boolean;
      extracted: ExtractedBill;
    }
  | { ok: false; error: string; duplicate?: boolean };

export async function ingestBill(
  sb: Sb,
  input: {
    buf: Buffer;
    fileName: string;
    mediaType: string;
    fileHash: string;
    extracted: ExtractedBill;
    units: UnitOption[];
    /** Where the statement came from ('pseg' | 'coned' | 'other'), when the
     *  submitter knows it — the statements agent always does. */
    source?: StatementSource | null;
  },
): Promise<IngestResult> {
  const { buf, mediaType, fileHash, units } = input;
  const extracted = { ...input.extracted };

  // The unit match is untrusted output from reading the statement — never
  // let it write an id outside the known unit list.
  if (
    extracted.property_id &&
    !units.some((u) => u.id === extracted.property_id)
  ) {
    extracted.property_id = null;
  }

  // Operator-confirmed mappings beat the reader's guess: if this account or
  // service address was ever manually assigned to a unit, reuse that unit.
  const keys = hintKeys(extracted);
  let learned = false;
  if (keys.length > 0) {
    const { data: hints } = await sb
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
      ok: false,
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
    // Without a full billing period or a statement date there is nothing to
    // key the duplicate check on — skip it rather than query on null.
    if (
      acct &&
      ((extracted.period_start && extracted.period_end) ||
        extracted.statement_date)
    ) {
      let q = sb
        .from("utility_bills")
        .select(
          "id, account_number, provider, utility_type, period_start, period_end",
        );
      if (extracted.period_start && extracted.period_end) {
        q = q
          .lt("period_start", extracted.period_end)
          .gt("period_end", extracted.period_start);
      } else if (extracted.statement_date) {
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
          ok: false,
          duplicate: true,
          error:
            `Duplicate — a ${dup.utility_type ?? ""} bill for this account` +
            `${covered} is already in the log` +
            `${dup.provider ? ` (${dup.provider})` : ""}. Discarded.`,
        };
      }
    }
  }

  // Store the statement, compressed as far as it will go (extraction already
  // ran on the original bytes; the hash also covers the original).
  const compressed = await compressStatement(buf, mediaType);
  let safeName = input.fileName.replace(/[^\w.\-]/g, "_") || "statement";
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
  if (upErr)
    return { ok: false, error: `Failed to store the statement: ${upErr.message}` };

  const total =
    Math.round(extracted.charges.reduce((s, c) => s + c.amount, 0) * 100) /
    100;
  const { data: bill, error: insErr } = await sb
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
      source: input.source ?? null,
    })
    .select("id")
    .single();
  if (insErr) {
    await sb.storage.from("utilities").remove([path]);
    return { ok: false, error: insErr.message };
  }

  const { error: chErr } = await sb.from("utility_bill_charges").insert(
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
    await sb.from("utility_bills").delete().eq("id", bill.id);
    await sb.storage.from("utilities").remove([path]);
    return { ok: false, error: chErr.message };
  }

  return {
    ok: true,
    billId: bill.id,
    total,
    unit: units.find((u) => u.id === extracted.property_id),
    learned,
    extracted,
  };
}
