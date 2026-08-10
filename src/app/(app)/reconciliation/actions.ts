"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { canEditLedger, LEDGER_ADMIN_ERROR } from "@/lib/access";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { LEDGER_PAYMENT_CUTOFF } from "@/lib/rent";
import {
  parseBankFile,
  parseOtherFile,
  bankPayerNameDisplay,
  type Deposit,
} from "@/lib/reconciliation/parsers";
import {
  loadPayerTenancies,
  loadIgnoredPayerKeys,
  buildPayerIndex,
  autoAssign,
  assignSyntheticOrdinals,
} from "@/lib/reconciliation/matching";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValid, zUuid } from "@/lib/validation";

// Store a statement's negative Zelle rows (chargebacks) as reversal alerts,
// each matched to its best-guess original payment: the most recent posted
// deposit from the same payer for the same amount. Upsert on the reversal's
// own fingerprint, so re-uploading an overlapping statement never duplicates
// an alert (or resurrects a resolved one).
async function saveReversals(
  supabase: SupabaseClient,
  reversals: Deposit[],
): Promise<void> {
  const insertedIds: string[] = [];
  try {
    for (const rev of reversals) {
      let suspectQuery = supabase
        .from("reconciliation_deposits")
        .select("payment_id")
        .eq("payer_key", rev.description)
        .eq("amount", rev.amount)
        .not("payment_id", "is", null)
        .order("deposit_date", { ascending: false });
      // A reversal can only point backward. Without this bound, a later payment
      // could be selected as the transaction supposedly being reversed.
      if (rev.date) suspectQuery = suspectQuery.lte("deposit_date", rev.date);
      const { data: suspect, error: suspectError } = await suspectQuery
        .limit(1)
        .maybeSingle();
      if (suspectError) throw new Error(suspectError.message);
      const { data: inserted, error } = await supabase
        .from("reconciliation_reversals")
        .upsert(
          {
            external_ref: rev.externalRef,
            payer_key: rev.description,
            raw_description: rev.raw,
            amount: rev.amount,
            deposit_date: rev.date,
            suspect_payment_id: suspect?.payment_id ?? null,
          },
          { onConflict: "external_ref", ignoreDuplicates: true },
        )
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (inserted?.id) insertedIds.push(inserted.id);
    }
  } catch (error) {
    if (insertedIds.length > 0) {
      await supabase.from("reconciliation_reversals").delete().in("id", insertedIds);
    }
    throw error;
  }
}

// ----------------------------------------------------------------------------
// 1. Add a statement. Parses the file(s), skips already-known transactions,
//    auto-matches payer keys, and posts matched deposits to the ledger
//    IMMEDIATELY — there is no separate preview/Post step anymore.
// ----------------------------------------------------------------------------

export type AddStatementState =
  | { error?: string; success?: string }
  | undefined;

type IngestResult = {
  statement_id: string;
  inserted: number;
  duplicates: number;
  posted: number;
};

export async function addStatement(
  _prev: AddStatementState,
  formData: FormData,
): Promise<AddStatementState> {
  const bankFile = formData.get("bank_statement");
  const otherFile = formData.get("other_payments");
  if (!(bankFile instanceof File) || bankFile.size === 0) {
    return { error: "Upload the bank statement file." };
  }

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  // 1) Parse in-memory.
  let bankResult;
  try {
    bankResult = await parseBankFile(bankFile);
  } catch (e) {
    return {
      error: `Couldn't read bank file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  console.log("[recon] bank parse:", {
    name: bankFile.name,
    size: bankFile.size,
    parsedRowCount: bankResult.parsedRowCount,
    deposits: bankResult.deposits.length,
    skipped: bankResult.skipped,
  });

  let otherResult = null;
  if (otherFile instanceof File && otherFile.size > 0) {
    try {
      otherResult = await parseOtherFile(otherFile);
    } catch (e) {
      return {
        error: `Couldn't read other-payments file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Every row must carry a real, non-future date. That's the whole guard —
  // the old per-month window is gone: the continuous recon accepts any past
  // transaction, and prepayments post to tenancies that start later.
  const today = todayISO();
  const allParsed = [
    ...bankResult.deposits,
    ...(otherResult?.deposits ?? []),
    ...bankResult.reversals,
  ];
  const bad = allParsed.find((d) => !d.date || d.date > today);
  if (bad) {
    return {
      error:
        `Every row needs a non-future transaction date. ` +
        `Found ${bad.date ?? "a missing date"} in "${bad.raw.slice(0, 80)}".`,
    };
  }
  if (bankResult.deposits.length === 0 && !otherResult) {
    return {
      error:
        "No deposits found in that file. " +
        (bankResult.skipped.length > 0
          ? `Skipped: ${bankResult.skipped.map((s) => `${s.count} ${s.reason.toLowerCase()}`).join(", ")}.`
          : "Check that it's a bank export with Description and Amount columns."),
    };
  }

  // 2) Fingerprint hygiene against everything already stored (the deposit log
  //    is global now), then auto-match payer keys — every tenancy is a
  //    candidate, including ones that haven't started yet.
  const { data: existingRefRows, error: refErr } = await supabase
    .from("reconciliation_deposits")
    .select("external_ref");
  if (refErr) return { error: `Failed to load existing deposits: ${refErr.message}` };
  const existingRefs = ((existingRefRows ?? []) as { external_ref: string }[]).map(
    (r) => r.external_ref,
  );

  const [{ rows: payerRows, error: ptErr }, ignoredKeys] = await Promise.all([
    loadPayerTenancies(supabase),
    loadIgnoredPayerKeys(supabase),
  ]);
  if (ptErr) return { error: `Failed to load tenancies: ${ptErr}` };
  const payerIndex = buildPayerIndex(payerRows);

  const safeName = (s: string) => s.replace(/[^\w.\-]/g, "_");
  const uploadedPaths: string[] = [];
  const results: IngestResult[] = [];

  const ingestFile = async (
    file: File,
    source: "bank" | "other",
    deposits: Deposit[],
    parsedRowCount: number,
    note: string | null,
  ): Promise<{ result?: IngestResult; error?: string }> => {
    const { deposits: prepared } = assignSyntheticOrdinals(
      deposits,
      existingRefs,
    );
    const assigned = autoAssign(prepared, payerIndex, ignoredKeys);

    const path = `statements/${Date.now()}-${source}-${safeName(file.name)}`;
    const { error: upErr } = await supabase.storage
      .from("reconciliation")
      .upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      return { error: `Failed to preserve the statement file: ${upErr.message}` };
    }
    uploadedPaths.push(path);

    const { data, error } = await supabase.rpc(
      "ingest_reconciliation_statement",
      {
        p_statement: {
          file_path: path,
          file_name: file.name,
          source,
          parsed_row_count: parsedRowCount,
          note,
          uploaded_by: user?.email ?? null,
        },
        p_deposits: assigned.map((d) => ({
          external_ref: d.externalRef,
          payer_key: d.description,
          raw_description: d.raw,
          amount: d.amount,
          deposit_date: d.date,
          tenancy_id: d.tenancyId,
        })),
      },
    );
    if (error) return { error: error.message };
    // Refs from this file now exist — the next file's ordinals must see them.
    existingRefs.push(...assigned.map((d) => d.externalRef));
    return { result: data as IngestResult };
  };

  const bankNote =
    bankResult.skipped.length > 0
      ? `Skipped: ${bankResult.skipped.map((s) => `${s.count} ${s.reason.toLowerCase()}`).join(", ")}.`
      : null;
  const bankIngest = await ingestFile(
    bankFile,
    "bank",
    bankResult.deposits,
    bankResult.parsedRowCount,
    bankNote,
  );
  if (bankIngest.error || !bankIngest.result) {
    await supabase.storage.from("reconciliation").remove(uploadedPaths);
    return { error: bankIngest.error ?? "Failed to ingest the statement." };
  }
  results.push(bankIngest.result);

  if (otherResult && otherFile instanceof File) {
    const otherIngest = await ingestFile(
      otherFile,
      "other",
      otherResult.deposits,
      otherResult.parsedRowCount,
      null,
    );
    if (otherIngest.error || !otherIngest.result) {
      await supabase.storage.from("reconciliation").remove(uploadedPaths);
      return { error: otherIngest.error ?? "Failed to ingest the other-payments file." };
    }
    results.push(otherIngest.result);
  }

  // 3) Flag negative Zelle rows (chargebacks) for review. Non-fatal by design:
  // the deposits are already ingested and posted, so surface the problem
  // without pretending the upload failed.
  let reversalNote = "";
  try {
    await saveReversals(supabase, bankResult.reversals);
    if (bankResult.reversals.length > 0) {
      reversalNote = ` ${bankResult.reversals.length} possible reversal${bankResult.reversals.length === 1 ? "" : "s"} flagged.`;
    }
  } catch (e) {
    reversalNote = ` Warning: reversal alerts failed to save (${e instanceof Error ? e.message : String(e)}).`;
  }

  const inserted = results.reduce((s, r) => s + r.inserted, 0);
  const duplicates = results.reduce((s, r) => s + r.duplicates, 0);
  const posted = results.reduce((s, r) => s + r.posted, 0);
  const coveredThrough = bankResult.deposits.reduce<string | null>(
    (max, d) => (d.date && (!max || d.date > max) ? d.date : max),
    null,
  );

  revalidatePath("/reconciliation");
  revalidatePath("/tenants");
  return {
    success:
      `Added ${inserted} deposit${inserted === 1 ? "" : "s"} — ${posted} posted to the ledger` +
      (duplicates > 0 ? `, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : "") +
      "." +
      (coveredThrough ? ` Covers through ${coveredThrough}.` : "") +
      reversalNote,
  };
}

// ----------------------------------------------------------------------------
// 2. Assign an unassigned deposit to a tenant. Posts to the ledger NOW, and
//    remembers the payer so future statements match automatically. Any other
//    unassigned deposits from the same payer post along with it.
// ----------------------------------------------------------------------------

export type AssignState = { error?: string; success?: string } | undefined;

export async function assignDeposit(
  _prev: AssignState,
  formData: FormData,
): Promise<AssignState> {
  const depositId = String(formData.get("deposit_id") ?? "");
  const tenancyId = String(formData.get("tenancy_id") ?? "");
  if (!depositId || !tenancyId) {
    return { error: "Pick a tenant to assign this deposit to." };
  }
  if (!isValid(zUuid, depositId) || !isValid(zUuid, tenancyId)) {
    return { error: "Invalid deposit or tenant id." };
  }

  const supabase = await createClient();
  // Posts money into a tenant ledger and permanently maps the payer —
  // operator-only.
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  const { data: dep, error: depErr } = await supabase
    .from("reconciliation_deposits")
    .select("id, payer_key, raw_description, payment_id")
    .eq("id", depositId)
    .maybeSingle<{
      id: string;
      payer_key: string;
      raw_description: string | null;
      payment_id: string | null;
    }>();
  if (depErr || !dep) return { error: "Couldn't find that deposit." };

  const { data: ten, error: tErr } = await supabase
    .from("tenancies")
    .select("tenant_id, tenants(full_name)")
    .eq("id", tenancyId)
    .maybeSingle<{
      tenant_id: string;
      tenants: { full_name: string } | { full_name: string }[] | null;
    }>();
  if (tErr || !ten?.tenant_id) return { error: "Couldn't find that tenant." };

  // Remember the payer → tenant mapping for every future statement. Upsert on
  // the payer key so re-assigning a payer simply moves it to the new tenant.
  const alias = dep.raw_description
    ? bankPayerNameDisplay(dep.raw_description)
    : dep.payer_key;
  const { error: upErr } = await supabase
    .from("tenant_payer_aliases")
    .upsert(
      { tenant_id: ten.tenant_id, payer_key: dep.payer_key, display_name: alias },
      { onConflict: "payer_key" },
    );
  if (upErr) return { error: `Failed to remember the payer: ${upErr.message}` };

  // Assigning affirms this payer IS rent — clear any stale not-rent flag.
  const { error: clearIgnoredError } = await supabase
    .from("ignored_payers")
    .delete()
    .eq("payer_key", dep.payer_key);
  if (clearIgnoredError) {
    return { error: `Failed to clear the not-rent flag: ${clearIgnoredError.message}` };
  }

  // Post this deposit, plus every other unposted deposit from the same payer
  // (the operator just told us whose money this is). Each RPC call verifies
  // the ledger's external_ref dedupe before writing.
  const { data: siblings } = await supabase
    .from("reconciliation_deposits")
    .select("id")
    .eq("payer_key", dep.payer_key)
    .is("payment_id", null)
    .is("dismissed_at", null)
    .returns<{ id: string }[]>();
  const toPost = [
    depositId,
    ...(siblings ?? []).map((s) => s.id).filter((id) => id !== depositId),
  ];

  let postedCount = 0;
  for (const id of toPost) {
    const { error } = await supabase.rpc("post_reconciliation_deposit", {
      p_deposit_id: id,
      p_tenancy_id: tenancyId,
    });
    if (error) {
      return {
        error:
          postedCount > 0
            ? `Posted ${postedCount} deposit${postedCount === 1 ? "" : "s"}, then failed: ${error.message}`
            : error.message,
      };
    }
    postedCount++;
  }

  const tenant = one(ten.tenants);
  revalidatePath("/reconciliation");
  revalidatePath("/tenants");
  return {
    success:
      `Posted ${postedCount} deposit${postedCount === 1 ? "" : "s"} to ${tenant?.full_name ?? "tenant"}'s ledger — ` +
      `"${alias}" will match them automatically from now on.`,
  };
}

// ----------------------------------------------------------------------------
// 3. Dismiss / restore a single unassigned transaction. Dismissed rows stay in
//    the unassigned section (collapsed, searchable) and can come back anytime.
// ----------------------------------------------------------------------------

export type DismissState = { error?: string; success?: string } | undefined;

export async function dismissDeposit(
  _prev: DismissState,
  formData: FormData,
): Promise<DismissState> {
  const depositId = String(formData.get("deposit_id") ?? "");
  if (!depositId) return { error: "Missing deposit." };
  if (!isValid(zUuid, depositId)) return { error: "Invalid deposit id." };

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  // The payment_id guard backs up the DB check constraint: a posted deposit
  // can't be dismissed (delete its payment from the tenant ledger instead —
  // that automatically returns the deposit to the unassigned list).
  const { data, error } = await supabase
    .from("reconciliation_deposits")
    .update({ dismissed_at: new Date().toISOString(), dismissed_by: user?.email ?? null })
    .eq("id", depositId)
    .is("payment_id", null)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "That deposit is already posted — it can't be dismissed." };

  revalidatePath("/reconciliation");
  return { success: "Transaction dismissed. Find it under Dismissed to restore it." };
}

export async function restoreDeposit(
  _prev: DismissState,
  formData: FormData,
): Promise<DismissState> {
  const depositId = String(formData.get("deposit_id") ?? "");
  if (!depositId) return { error: "Missing deposit." };
  if (!isValid(zUuid, depositId)) return { error: "Invalid deposit id." };

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  const { error } = await supabase
    .from("reconciliation_deposits")
    .update({ dismissed_at: null, dismissed_by: null })
    .eq("id", depositId);
  if (error) return { error: error.message };

  revalidatePath("/reconciliation");
  return { success: "Transaction restored to the unassigned list." };
}

// ---------------------------------------------------------------------------
// Bulk manual payments — record rent payments for several tenants at once
// (for payments outside a bank statement). Reads every `amount:<tenancy_id>`
// field; inserts a rent payment for each non-empty, positive amount.
// ---------------------------------------------------------------------------

export type BulkPaymentState = { error?: string; success?: string } | undefined;

export async function recordManualPayments(
  _prev: BulkPaymentState,
  formData: FormData,
): Promise<BulkPaymentState> {
  const paid_on = String(formData.get("paid_on") ?? "").trim();
  if (!paid_on) return { error: "Pick a payment date." };
  // Same date guards as the single-payment form — one shared date governs
  // every row here, so a typo would misdate the whole batch at once.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_on))
    return { error: "Payment date must be YYYY-MM-DD." };
  if (paid_on > todayISO())
    return { error: "Payment date can't be in the future." };
  // Rent dated before the ledger cutoff is silently excluded from every
  // balance (pre-ledger months are treated as settled) — recording it would
  // create invisible money, so refuse the batch outright.
  if (paid_on < LEDGER_PAYMENT_CUTOFF)
    return {
      error: `Rent payments must be dated ${LEDGER_PAYMENT_CUTOFF} or later — earlier dates predate the ledger and wouldn't count toward any balance.`,
    };

  const rows: {
    tenancy_id: string;
    paid_on: string;
    amount: number;
    payment_type: "rent";
    method: string;
    notes: string;
  }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("amount:")) continue;
    const raw = String(value).trim();
    if (!raw) continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const tenancyId = key.slice("amount:".length);
    if (!isValid(zUuid, tenancyId))
      return { error: "A payment row has an invalid tenancy id." };
    rows.push({
      tenancy_id: tenancyId,
      paid_on,
      amount,
      payment_type: "rent",
      method: "Manual",
      notes: "Manual entry",
    });
  }

  if (rows.length === 0) return { error: "Enter an amount for at least one tenant." };

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };
  const { error } = await supabase.from("payments").insert(rows);
  if (error) return { error: error.message };

  revalidatePath("/reconciliation");
  revalidatePath("/tenants");
  return {
    success: `Recorded ${rows.length} payment${rows.length === 1 ? "" : "s"}.`,
  };
}

// ---------------------------------------------------------------------------
// Ignore a payer: their deposits are not rent (personal transfers, other
// ventures) — remembered globally, the mirror image of the assign flow's
// payer alias. Their transactions show under Dismissed until un-ignored.
// ---------------------------------------------------------------------------

export type IgnorePayerState = { error?: string; success?: string } | undefined;

export async function ignoreUnmatchedPayer(
  _prev: IgnorePayerState,
  formData: FormData,
): Promise<IgnorePayerState> {
  const payerKey = String(formData.get("payer_key") ?? "");
  if (!payerKey) return { error: "Missing payer." };

  const supabase = await createClient();
  // Hiding money from the books is a ledger-level decision — same gate as
  // assigning.
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  // Prefer the bank's original casing for display.
  const { data: dep } = await supabase
    .from("reconciliation_deposits")
    .select("raw_description")
    .eq("payer_key", payerKey)
    .limit(1)
    .maybeSingle<{ raw_description: string | null }>();
  const display = dep?.raw_description
    ? bankPayerNameDisplay(dep.raw_description)
    : payerKey;

  const { error } = await supabase
    .from("ignored_payers")
    .upsert(
      { payer_key: payerKey, display_name: display, created_by: user?.email ?? null },
      { onConflict: "payer_key" },
    );
  if (error) return { error: error.message };

  revalidatePath("/reconciliation");
  return {
    success: `"${display}" marked not-rent — their transactions stay out of the unassigned list.`,
  };
}

export async function unignorePayer(formData: FormData) {
  const payerKey = String(formData.get("payer_key") ?? "");
  if (!payerKey) return;

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);

  const { error: deleteError } = await supabase
    .from("ignored_payers")
    .delete()
    .eq("payer_key", payerKey);
  if (deleteError) throw new Error(deleteError.message);

  revalidatePath("/reconciliation");
}

// ---------------------------------------------------------------------------
// Resolve a reversal alert: record the offsetting refund on the suspect
// payment's tenancy (debiting their ledger), or dismiss it (the reversed
// transfer wasn't rent / was handled elsewhere).
// ---------------------------------------------------------------------------

export type ReversalState = { error?: string; success?: string } | undefined;

export async function resolveReversal(
  _prev: ReversalState,
  formData: FormData,
): Promise<ReversalState> {
  const id = String(formData.get("id") ?? "");
  const mode = String(formData.get("mode") ?? "");
  if (!isValid(zUuid, id) || (mode !== "refund" && mode !== "dismiss")) {
    return { error: "Invalid reversal action." };
  }

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  // The refund payment and alert resolution commit together. The database
  // also verifies any pre-existing external_ref matches amount/date/type.
  const { data, error } = await supabase.rpc(
    "resolve_reconciliation_reversal",
    {
      p_reversal_id: id,
      p_mode: mode,
      p_resolved_by: user?.email ?? "unknown",
    },
  );
  if (error) return { error: error.message };
  const result = data as { amount: number; already_resolved: boolean };
  if (result.already_resolved) return { success: "Already resolved." };

  revalidatePath("/reconciliation");
  revalidatePath("/tenants");
  return {
    success:
      mode === "refund"
        ? `Refund of $${Number(result.amount).toLocaleString()} recorded — the tenant's ledger now reflects the returned money.`
        : "Reversal dismissed.",
  };
}
