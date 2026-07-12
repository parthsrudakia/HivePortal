"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canEditLedger, isMaster, LEDGER_ADMIN_ERROR } from "@/lib/access";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import {
  parseBankFile,
  parseOtherFile,
  bankPayerNameDisplay,
  type Deposit,
} from "@/lib/reconciliation/parsers";
import {
  monthBounds,
  loadMonthTenancies,
  buildMatches,
  recomputeRun,
} from "@/lib/reconciliation/matching";
import type { SupabaseClient } from "@supabase/supabase-js";

export type RunFormState = { error?: string } | undefined;

// ----------------------------------------------------------------------------
// 1. Upload + match → creates a preview run (no payments written yet).
// ----------------------------------------------------------------------------

export async function runReconciliation(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const monthRaw = String(formData.get("month") ?? "").trim();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthRaw)
    ? `${monthRaw}-01`
    : monthRaw;
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(month)) {
    return { error: "Pick a month for this reconciliation." };
  }

  const bankFile = formData.get("bank_statement");
  const otherFile = formData.get("other_payments");

  if (!(bankFile instanceof File) || bankFile.size === 0) {
    return { error: "Upload the bank statement file." };
  }

  const supabase = await createClient();

  // 1) Parse both files in-memory.
  let bankResult, otherResult;
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

  let allDeposits: Deposit[] = bankResult.deposits;
  if (otherFile instanceof File && otherFile.size > 0) {
    try {
      otherResult = await parseOtherFile(otherFile);
    } catch (e) {
      return {
        error: `Couldn't read other-payments file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    console.log("[recon] other parse:", {
      name: otherFile.name,
      size: otherFile.size,
      parsedRowCount: otherResult.parsedRowCount,
      deposits: otherResult.deposits.length,
    });
    allDeposits = [...allDeposits, ...otherResult.deposits];
  }

  // Fingerprint hygiene, in two parts:
  // 1) Rows WITH a Conf#: the same confirmation number twice in one export is
  //    the same transaction listed twice — keep the first, drop the rest so
  //    the run's "collected" totals aren't inflated (posting was already
  //    deduped by the unique index, but the display wasn't).
  // 2) Rows WITHOUT a Conf# (synthetic fingerprints): scope by run month and
  //    an occurrence ordinal. Otherwise (a) a dateless file posted in June
  //    collides with the identical row in July's file — July's money would
  //    silently never post — and (b) two identical same-day cash rows in one
  //    file would post once while displaying twice.
  {
    const seenConf = new Set<string>();
    const occurrence = new Map<string, number>();
    const deduped: Deposit[] = [];
    let confDupes = 0;
    for (const d of allDeposits) {
      if (d.externalRef.startsWith("zelle:")) {
        if (seenConf.has(d.externalRef)) {
          confDupes++;
          continue;
        }
        seenConf.add(d.externalRef);
        deduped.push(d);
      } else {
        const n = (occurrence.get(d.externalRef) ?? 0) + 1;
        occurrence.set(d.externalRef, n);
        deduped.push({ ...d, externalRef: `${d.externalRef}:${month}:${n}` });
      }
    }
    allDeposits = deduped;
    if (confDupes > 0) {
      console.log(`[recon] dropped ${confDupes} duplicate Conf# rows`);
    }
  }

  // 2) Snapshot tenancies that overlapped the selected month (including ones
  //    that ended mid-month, whose payments would otherwise go unattributed).
  const { start, end } = monthBounds(month);
  const { tenancies: tenancyRows, error: tErr } = await loadMonthTenancies(
    supabase,
    start,
    end,
  );
  if (tErr) return { error: `Failed to load tenancies: ${tErr}` };
  console.log("[recon] tenancies loaded:", tenancyRows.length);

  // 3) Create the run (preview state, posted_at = null). Build a diagnostic
  // note so the operator can immediately see what happened.
  const diagnostics =
    `Parsed ${bankResult.parsedRowCount} bank rows → ${bankResult.deposits.length} deposits. ` +
    (otherResult
      ? `Parsed ${otherResult.parsedRowCount} other-file rows → ${otherResult.deposits.length} deposits. `
      : "") +
    `Loaded ${tenancyRows.length} tenancies for month.` +
    (bankResult.skipped.length > 0
      ? ` Bank skipped: ${bankResult.skipped.map((s) => `${s.count} ${s.reason.toLowerCase()}`).join(", ")}.`
      : "");

  const { data: runIns, error: runErr } = await supabase
    .from("reconciliation_runs")
    .insert({ month, notes: diagnostics })
    .select("id")
    .single();
  if (runErr || !runIns) {
    return { error: runErr?.message ?? "Failed to create run." };
  }
  const runId = runIns.id;
  console.log("[recon] run created:", runId);

  // 4) Upload source files to storage (audit trail; non-fatal on failure —
  //    but don't record a path pointing at an object that failed to store).
  const safeName = (s: string) => s.replace(/[^\w.\-]/g, "_");
  let bankPath: string | null = `${runId}/bank-${Date.now()}-${safeName(bankFile.name)}`;
  {
    const { error: upErr } = await supabase.storage
      .from("reconciliation")
      .upload(bankPath, bankFile, {
        contentType: bankFile.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.error("[recon] bank file upload failed:", upErr.message);
      bankPath = null;
    }
  }

  let otherPath: string | null = null;
  if (otherFile instanceof File && otherFile.size > 0) {
    otherPath = `${runId}/other-${Date.now()}-${safeName(otherFile.name)}`;
    const { error: upErr } = await supabase.storage
      .from("reconciliation")
      .upload(otherPath, otherFile, {
        contentType: otherFile.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.error("[recon] other file upload failed:", upErr.message);
      otherPath = null;
    }
  }

  // 5) Build per-tenant matches.
  const { matches, tenancyByKey, unmatched, totals } = buildMatches(
    allDeposits,
    tenancyRows,
    start,
    end,
    runId,
  );

  if (matches.length > 0) {
    const { error: mErr } = await supabase
      .from("reconciliation_matches")
      .insert(matches);
    if (mErr) {
      await supabase.from("reconciliation_runs").delete().eq("id", runId);
      return { error: `Failed to save matches: ${mErr.message}` };
    }
  }

  // 5b) Save every parsed deposit (matched or not) so Post payments can
  //     iterate them and dedupe by external_ref.
  const depositRows = allDeposits.map((d) => ({
    run_id: runId,
    tenancy_id: tenancyByKey.get(d.description) ?? null,
    external_ref: d.externalRef,
    payer_key: d.description,
    raw_description: d.raw,
    amount: d.amount,
    deposit_date: d.date,
  }));
  if (depositRows.length > 0) {
    const { error: dErr } = await supabase
      .from("reconciliation_deposits")
      .insert(depositRows);
    if (dErr) {
      // Deposits are REQUIRED to post — without them Post would silently write
      // nothing yet mark the run "posted". Roll the whole run back instead of
      // leaving a run that looks ready but isn't.
      await supabase
        .from("reconciliation_matches")
        .delete()
        .eq("run_id", runId);
      await supabase.from("reconciliation_runs").delete().eq("id", runId);
      return { error: `Failed to save deposits: ${dErr.message}` };
    }
  }

  await supabase
    .from("reconciliation_runs")
    .update({
      bank_statement_path: bankPath,
      other_payments_path: otherPath,
      total_expected: totals.totalExpected,
      total_actual: totals.totalActual,
      match_count: totals.matchCount,
      mismatch_count: totals.mismatchCount,
      missing_count: totals.missingCount,
      unmatched_deposits: unmatched,
    })
    .eq("id", runId);

  revalidatePath("/reconciliation");
  redirect(`/reconciliation/${runId}`);
}

// ----------------------------------------------------------------------------
// 1b. Add another statement to an existing (unposted) run: parse it, append
//     only the deposits the run doesn't already have, and re-derive matches.
// ----------------------------------------------------------------------------

export type AddStatementState =
  | { error?: string; success?: string }
  | undefined;

export async function addStatementToRun(
  _prev: AddStatementState,
  formData: FormData,
): Promise<AddStatementState> {
  const runId = String(formData.get("run_id") ?? "");
  const file = formData.get("bank_statement");
  if (!runId) return { error: "Missing run id." };
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Upload a statement file." };
  }

  const supabase = await createClient();
  const { data: run } = await supabase
    .from("reconciliation_runs")
    .select("id, month, posted_at, notes")
    .eq("id", runId)
    .maybeSingle<{
      id: string;
      month: string;
      posted_at: string | null;
      notes: string | null;
    }>();
  if (!run) return { error: "Run not found." };
  if (run.posted_at) {
    return {
      error:
        "This run is already posted — unpost it before adding another statement.",
    };
  }

  let parsed;
  try {
    parsed = await parseBankFile(file);
  } catch (e) {
    return {
      error: `Couldn't read bank file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Same fingerprint hygiene as run creation, extended across the run:
  // Conf# rows the run already holds (overlapping exports) are skipped, and
  // synthetic month:ordinal refs continue counting from the existing rows so
  // a re-uploaded cash row can't collide with — or shadow — an earlier one.
  const { data: existingDeps } = await supabase
    .from("reconciliation_deposits")
    .select("external_ref")
    .eq("run_id", runId);
  const existingRefs = new Set(
    ((existingDeps ?? []) as { external_ref: string }[]).map(
      (r) => r.external_ref,
    ),
  );
  const occurrence = new Map<string, number>();
  for (const ref of existingRefs) {
    const m = ref.match(/^(.*):(\d{4}-\d{2}-\d{2}):(\d+)$/);
    if (m && m[2] === run.month) {
      occurrence.set(
        m[1],
        Math.max(occurrence.get(m[1]) ?? 0, Number(m[3])),
      );
    }
  }

  const fresh: Deposit[] = [];
  let dupes = 0;
  for (const d of parsed.deposits) {
    if (d.externalRef.startsWith("zelle:")) {
      if (existingRefs.has(d.externalRef)) {
        dupes++;
        continue;
      }
      existingRefs.add(d.externalRef);
      fresh.push(d);
    } else {
      const n = (occurrence.get(d.externalRef) ?? 0) + 1;
      occurrence.set(d.externalRef, n);
      fresh.push({ ...d, externalRef: `${d.externalRef}:${run.month}:${n}` });
    }
  }

  if (fresh.length === 0) {
    return {
      error: `No new deposits — all ${dupes} deposit row${dupes === 1 ? " is" : "s are"} already in this run.`,
    };
  }

  const { error: dErr } = await supabase.from("reconciliation_deposits").insert(
    fresh.map((d) => ({
      run_id: runId,
      tenancy_id: null, // recompute re-points these below
      external_ref: d.externalRef,
      payer_key: d.description,
      raw_description: d.raw,
      amount: d.amount,
      deposit_date: d.date,
    })),
  );
  if (dErr) return { error: `Failed to save deposits: ${dErr.message}` };

  // Audit trail: store the file alongside the run's other sources (the run
  // folder is what Delete cleans up) and note what this upload contributed.
  const safeName = (s: string) => s.replace(/[^\w.\-]/g, "_");
  const path = `${runId}/bank-${Date.now()}-${safeName(file.name)}`;
  const { error: upErr } = await supabase.storage
    .from("reconciliation")
    .upload(path, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (upErr) console.error("[recon] statement upload failed:", upErr.message);

  const note =
    `Added ${file.name}: ${parsed.parsedRowCount} rows → ${fresh.length} new deposits` +
    (dupes > 0 ? `, ${dupes} duplicates skipped` : "") +
    ".";
  await supabase
    .from("reconciliation_runs")
    .update({ notes: run.notes ? `${run.notes}\n${note}` : note })
    .eq("id", runId);

  // Fold the new deposits into matches/totals/unmatched. If this throws the
  // deposits are already saved — the run page recomputes on view anyway.
  try {
    await recomputeRun(supabase, runId);
  } catch (e) {
    console.error("[recon] recompute after add-statement failed:", e);
  }

  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${runId}`);
  return {
    success:
      `Added ${fresh.length} deposit${fresh.length === 1 ? "" : "s"}` +
      (dupes > 0 ? ` (${dupes} duplicates skipped)` : "") +
      ".",
  };
}

// ----------------------------------------------------------------------------
// 2. Post payments: write a payments table row for each matched tenancy.
//    Idempotent — re-posting upserts on external_ref (ON CONFLICT DO NOTHING)
//    and re-links deposits, so it never duplicates. If ANY deposit fails to
//    post, the run is NOT marked posted and the action throws, so the UI can
//    surface the failure instead of falsely reporting success.
// ----------------------------------------------------------------------------

async function postRunCore(supabase: SupabaseClient, runId: string) {
  // Load every parsed deposit on this run that matched a tenancy.
  const { data: deposits, error: dErr } = await supabase
    .from("reconciliation_deposits")
    .select(
      "id, tenancy_id, external_ref, amount, deposit_date, raw_description",
    )
    .eq("run_id", runId)
    .not("tenancy_id", "is", null);
  if (dErr) {
    throw new Error(`Failed to load deposits: ${dErr.message}`);
  }
  if (!deposits || deposits.length === 0) {
    // Could be legitimate (nothing matched a tenant) OR a data problem (the
    // deposit rows are missing). Distinguish via the run's own counts: if it
    // matched any paying tenant there MUST be deposits to post — so refuse to
    // mark it "posted" while writing nothing.
    const { data: run } = await supabase
      .from("reconciliation_runs")
      .select("match_count, mismatch_count")
      .eq("id", runId)
      .maybeSingle();
    const expectedToPost =
      (run?.match_count ?? 0) + (run?.mismatch_count ?? 0);
    if (expectedToPost > 0) {
      throw new Error(
        `This run matched ${expectedToPost} paying tenant(s) but has no deposit ` +
          `records to post — the run is corrupt. Re-run this reconciliation before posting.`,
      );
    }
    // Genuinely nothing to credit (all missing/unmatched): safe to mark posted.
    await supabase
      .from("reconciliation_runs")
      .update({ posted_at: new Date().toISOString() })
      .eq("id", runId);
    return;
  }

  const stamp = todayISO();

  // For each matched deposit:
  //   1) try to insert a payments row with external_ref = the deposit's
  //      Conf# (or synthetic fingerprint). If it already exists from a
  //      prior overlapping bank statement run, ON CONFLICT short-circuits
  //      and we just re-link this deposit to the existing payment.
  //   2) update the deposit row with payment_id so future Unpost knows.
  // Failures are collected, not swallowed: a single failed upsert must not
  // let the run be marked posted while payments are missing.
  const failures: string[] = [];
  for (const d of deposits) {
    if (!d.tenancy_id) continue;
    const { data: ins, error: pErr } = await supabase
      .from("payments")
      .upsert(
        {
          tenancy_id: d.tenancy_id,
          paid_on: d.deposit_date ?? stamp,
          amount: Number(d.amount),
          payment_type: "rent",
          method: "Reconciliation",
          notes: `Posted from recon (${d.external_ref})`,
          reconciliation_run_id: runId,
          external_ref: d.external_ref,
        },
        { onConflict: "external_ref", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (pErr) {
      console.error("[recon] upsert payment failed:", pErr, d.external_ref);
      failures.push(`${d.external_ref}: ${pErr.message}`);
      continue;
    }
    let paymentId: string | null = ins?.id ?? null;
    // If ignored (conflict), look up the existing row so we can link. When
    // the deposit was re-attributed since (e.g. a pays_as fix moved it to a
    // different tenancy), move the money too — otherwise the match table
    // would show the new tenant paid while the ledger credits the old one.
    if (!paymentId) {
      const { data: existing } = await supabase
        .from("payments")
        .select("id, tenancy_id")
        .eq("external_ref", d.external_ref)
        .maybeSingle();
      paymentId = existing?.id ?? null;
      if (existing && existing.tenancy_id !== d.tenancy_id) {
        const { error: moveErr } = await supabase
          .from("payments")
          .update({ tenancy_id: d.tenancy_id })
          .eq("id", existing.id);
        if (moveErr) {
          failures.push(`${d.external_ref}: ${moveErr.message}`);
          continue;
        }
      }
    }
    if (paymentId) {
      const { error: linkErr } = await supabase
        .from("reconciliation_deposits")
        .update({ payment_id: paymentId })
        .eq("id", d.id);
      if (linkErr) {
        console.error("[recon] link deposit failed:", linkErr, d.external_ref);
        failures.push(`${d.external_ref}: ${linkErr.message}`);
      }
    } else {
      failures.push(`${d.external_ref}: no payment row written or found`);
    }
  }

  // Don't mark the run posted if anything failed — surface it instead, so
  // the user isn't told "posted" while Tenants & Rent stays empty.
  if (failures.length > 0) {
    throw new Error(
      `Posted ${deposits.length - failures.length}/${deposits.length} payments; ` +
        `${failures.length} failed. First error — ${failures[0]}`,
    );
  }

  await supabase
    .from("reconciliation_runs")
    .update({ posted_at: new Date().toISOString() })
    .eq("id", runId);
}

export async function postPayments(formData: FormData) {
  const runId = String(formData.get("run_id") ?? "");
  if (!runId) return;
  const supabase = await createClient();
  // Posting writes a month of payments into tenant ledgers — operator-only,
  // same restriction as ledger charges.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);
  await postRunCore(supabase, runId);
  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${runId}`);
  revalidatePath("/tenants");
}

export async function unpostPayments(formData: FormData) {
  const runId = String(formData.get("run_id") ?? "");
  if (!runId) return;

  const supabase = await createClient();
  // Unposting deletes a month of payments from tenant ledgers — operator-only.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) throw new Error(LEDGER_ADMIN_ERROR);

  // Delete by the payment ids this run's deposits were LINKED to at post
  // time — not by external_ref. Matching on refs made unpost a silent no-op
  // whenever another run (even an unposted preview of the same statement)
  // held the same refs. A payment is kept only if a *different* run's
  // deposit is actually linked to it (payment_id set, i.e. that run posted).
  const { data: deps } = await supabase
    .from("reconciliation_deposits")
    .select("payment_id")
    .eq("run_id", runId)
    .not("payment_id", "is", null);
  const paymentIds = Array.from(
    new Set(
      ((deps ?? []) as { payment_id: string }[]).map((d) => d.payment_id),
    ),
  );
  if (paymentIds.length > 0) {
    const { data: otherLinks } = await supabase
      .from("reconciliation_deposits")
      .select("payment_id")
      .neq("run_id", runId)
      .in("payment_id", paymentIds);
    const keep = new Set(
      ((otherLinks ?? []) as { payment_id: string }[]).map(
        (r) => r.payment_id,
      ),
    );
    const safeToDelete = paymentIds.filter((id) => !keep.has(id));
    if (safeToDelete.length > 0) {
      await supabase.from("payments").delete().in("id", safeToDelete);
    }
  }

  // Detach this run's deposits from their payment rows.
  await supabase
    .from("reconciliation_deposits")
    .update({ payment_id: null })
    .eq("run_id", runId);

  await supabase
    .from("reconciliation_runs")
    .update({ posted_at: null })
    .eq("id", runId);

  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${runId}`);
  revalidatePath("/tenants");
}

// ----------------------------------------------------------------------------
// 3. Delete a run (and its payments + source files).
// ----------------------------------------------------------------------------

export async function deleteRun(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  // Deleting a run also wipes the payments it posted, so restrict it to the
  // master operator. UI hides the button for everyone else; this is the real
  // enforcement since the action is directly invokable.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isMaster(user?.email)) {
    throw new Error("Only an admin can delete a reconciliation run.");
  }

  const { data: objects } = await supabase.storage
    .from("reconciliation")
    .list(id);
  if (objects && objects.length > 0) {
    await supabase.storage
      .from("reconciliation")
      .remove(objects.map((o) => `${id}/${o.name}`));
  }
  // Keep any payment another run's posted deposits are linked to — a payment
  // created by this run can since have been adopted by an overlapping run.
  const { data: mine } = await supabase
    .from("payments")
    .select("id")
    .eq("reconciliation_run_id", id);
  const mineIds = (mine ?? []).map((p) => p.id);
  if (mineIds.length > 0) {
    const { data: otherLinks } = await supabase
      .from("reconciliation_deposits")
      .select("payment_id")
      .neq("run_id", id)
      .in("payment_id", mineIds);
    const keep = new Set(
      ((otherLinks ?? []) as { payment_id: string }[]).map((r) => r.payment_id),
    );
    const del = mineIds.filter((p) => !keep.has(p));
    if (del.length > 0) {
      await supabase.from("payments").delete().in("id", del);
    }
  }
  await supabase.from("reconciliation_runs").delete().eq("id", id);
  revalidatePath("/reconciliation");
  redirect("/reconciliation");
}

// ---------------------------------------------------------------------------
// Bulk manual payments — record rent payments for several tenants at once from
// the Reconciliation tab (for payments outside a bank-statement run). Reads
// every `amount:<tenancy_id>` field; inserts a rent payment for each non-empty,
// positive amount, all dated `paid_on`.
// ---------------------------------------------------------------------------

export type BulkPaymentState = { error?: string; success?: string } | undefined;

export async function recordManualPayments(
  _prev: BulkPaymentState,
  formData: FormData,
): Promise<BulkPaymentState> {
  const paid_on = String(formData.get("paid_on") ?? "").trim();
  if (!paid_on) return { error: "Pick a payment date." };

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
    rows.push({
      tenancy_id: key.slice("amount:".length),
      paid_on,
      amount,
      payment_type: "rent",
      method: "Manual",
      notes: "Manual entry",
    });
  }

  if (rows.length === 0) return { error: "Enter an amount for at least one tenant." };

  const supabase = await createClient();
  const { error } = await supabase.from("payments").insert(rows);
  if (error) return { error: error.message };

  revalidatePath("/reconciliation");
  revalidatePath("/tenants");
  return {
    success: `Recorded ${rows.length} payment${rows.length === 1 ? "" : "s"}.`,
  };
}

// ---------------------------------------------------------------------------
// H2 — attribute unmatched deposits. Re-derive a run's matches/totals from its
// already-saved deposits against the CURRENT tenancy data, then let the operator
// assign an unmatched deposit to a tenant by recording the bank's payer name as
// that tenant's pays_as alias (so it auto-matches now and forever after).
// ---------------------------------------------------------------------------


export type AssignState = { error?: string; success?: string } | undefined;

export async function assignUnmatchedDeposit(
  _prev: AssignState,
  formData: FormData,
): Promise<AssignState> {
  const runId = String(formData.get("run_id") ?? "");
  const tenancyId = String(formData.get("tenancy_id") ?? "");
  const payerKey = String(formData.get("payer_key") ?? "");
  if (!runId || !tenancyId || !payerKey) {
    return { error: "Pick a tenant to assign this deposit to." };
  }

  const supabase = await createClient();
  // Permanently maps this payer to the tenant and can immediately re-post
  // money on a posted run — operator-only.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!canEditLedger(user?.email)) return { error: LEDGER_ADMIN_ERROR };

  // Resolve the tenant behind the chosen tenancy.
  const { data: ten, error: tErr } = await supabase
    .from("tenancies")
    .select("tenant_id, tenants(full_name)")
    .eq("id", tenancyId)
    .maybeSingle<{
      tenant_id: string;
      tenants: { full_name: string } | { full_name: string }[] | null;
    }>();
  if (tErr || !ten?.tenant_id) {
    return { error: "Couldn't find that tenant." };
  }

  // The bank's printed payer name (original case), kept for display.
  const { data: dep } = await supabase
    .from("reconciliation_deposits")
    .select("raw_description")
    .eq("run_id", runId)
    .eq("payer_key", payerKey)
    .limit(1)
    .maybeSingle<{ raw_description: string | null }>();
  const alias = dep?.raw_description
    ? bankPayerNameDisplay(dep.raw_description)
    : payerKey;

  // Remember the payer → tenant mapping for every future run. Upsert on the
  // payer key so re-assigning a payer simply moves it to the new tenant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upErr } = await (supabase as any)
    .from("tenant_payer_aliases")
    .upsert(
      {
        tenant_id: ten.tenant_id,
        payer_key: payerKey,
        display_name: alias,
      },
      { onConflict: "payer_key" },
    );
  if (upErr) return { error: `Failed to remember the payer: ${upErr.message}` };

  try {
    await recomputeRun(supabase, runId);
    // If the run was already posted, credit the newly-matched deposit now.
    const { data: run } = await supabase
      .from("reconciliation_runs")
      .select("posted_at")
      .eq("id", runId)
      .maybeSingle<{ posted_at: string | null }>();
    if (run?.posted_at) await postRunCore(supabase, runId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const tenant = one(ten.tenants);
  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${runId}`);
  revalidatePath("/tenants");
  return {
    success: `Assigned to ${tenant?.full_name ?? "tenant"} — "${alias}" will match them automatically in future runs.`,
  };
}
