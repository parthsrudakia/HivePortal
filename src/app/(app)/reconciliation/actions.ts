"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import {
  parseBankFile,
  parseOtherFile,
  aggregateByDescription,
  unmatchedDeposits,
  tenantKey,
  type Deposit,
} from "@/lib/reconciliation/parsers";

export type RunFormState = { error?: string } | undefined;

function monthBounds(monthIso: string): { start: string; end: string } {
  const [y, m] = monthIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// ----------------------------------------------------------------------------
// 1. Upload + match → creates a preview run (no payments written yet).
// ----------------------------------------------------------------------------

export async function runReconciliation(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const monthRaw = String(formData.get("month") ?? "").trim();
  const month = /^\d{4}-\d{2}$/.test(monthRaw)
    ? `${monthRaw}-01`
    : monthRaw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(month)) {
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

  const aggregate = aggregateByDescription(allDeposits);

  // 2) Snapshot active tenancies in the selected month.
  const { start, end } = monthBounds(month);

  type TenantRel = { id: string; full_name: string; pays_as: string | null };
  type PropertyRel = {
    building_name: string | null;
    street_address: string;
    unit_number: string;
  };
  type RoomRel = {
    room_number: string | null;
    properties: PropertyRel | PropertyRel[] | null;
  };
  type TenancyRow = {
    id: string;
    tenant_id: string;
    monthly_rent: number;
    start_date: string;
    end_date: string | null;
    tenants: TenantRel | TenantRel[] | null;
    rooms: RoomRel | RoomRel[] | null;
  };

  const { data: tenancies, error: tErr } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, start_date, end_date,
       tenants(id, full_name, pays_as),
       rooms(room_number,
             properties(building_name, street_address, unit_number))`,
    )
    .eq("status", "active")
    .lte("start_date", end)
    .or(`end_date.is.null,end_date.gte.${start}`)
    .returns<TenancyRow[]>();

  if (tErr) return { error: `Failed to load tenancies: ${tErr.message}` };
  const tenancyRows = tenancies ?? [];
  console.log("[recon] tenancies loaded:", tenancyRows.length);

  // 3) Create the run (preview state, posted_at = null). Build a diagnostic
  // note so the operator can immediately see what happened.
  const diagnostics =
    `Parsed ${bankResult.parsedRowCount} bank rows → ${bankResult.deposits.length} deposits. ` +
    (otherResult
      ? `Parsed ${otherResult.parsedRowCount} other-file rows → ${otherResult.deposits.length} deposits. `
      : "") +
    `Loaded ${tenancyRows.length} active tenancies for month.` +
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

  // 4) Upload source files to storage (audit trail; non-fatal on failure).
  const safeName = (s: string) => s.replace(/[^\w.\-]/g, "_");
  const bankPath = `${runId}/bank-${Date.now()}-${safeName(bankFile.name)}`;
  await supabase.storage
    .from("reconciliation")
    .upload(bankPath, bankFile, {
      contentType: bankFile.type || "application/octet-stream",
      upsert: false,
    });

  let otherPath: string | null = null;
  if (otherFile instanceof File && otherFile.size > 0) {
    otherPath = `${runId}/other-${Date.now()}-${safeName(otherFile.name)}`;
    await supabase.storage
      .from("reconciliation")
      .upload(otherPath, otherFile, {
        contentType: otherFile.type || "application/octet-stream",
        upsert: false,
      });
  }

  // 5) Build per-tenant matches AND save the raw per-deposit rows so we
  //    can dedupe later at Post time.
  type MatchRow = {
    run_id: string;
    tenancy_id: string;
    tenant_id: string | null;
    tenant_name: string;
    pays_as: string;
    property_label: string | null;
    room_label: string | null;
    expected_rent: number;
    actual_amount: number;
    difference: number;
    status: "match" | "mismatch" | "missing";
  };
  const matches: MatchRow[] = [];
  const claimedKeys = new Set<string>();
  const tenancyByKey = new Map<string, string>();
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;
  let totalExpected = 0;
  let totalActual = 0;

  for (const t of tenancyRows) {
    const tenant = one(t.tenants);
    if (!tenant) continue;

    const rawKey = tenantKey(tenant.pays_as, tenant.full_name);
    const expected = Number(t.monthly_rent);
    const actual = aggregate.get(rawKey) ?? 0;
    if (actual > 0) {
      claimedKeys.add(rawKey);
      tenancyByKey.set(rawKey, t.id);
    }

    const difference = actual - expected;
    let status: MatchRow["status"];
    if (actual <= 0) status = "missing";
    else if (Math.abs(difference) < 0.01) status = "match";
    else status = "mismatch";

    totalExpected += expected;
    totalActual += actual;
    if (status === "match") matchCount++;
    else if (status === "mismatch") mismatchCount++;
    else missingCount++;

    const room = one(t.rooms);
    const property = one(room?.properties ?? null);
    const propertyLabel = property
      ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
      : null;

    matches.push({
      run_id: runId,
      tenancy_id: t.id,
      tenant_id: tenant.id,
      tenant_name: tenant.full_name,
      pays_as: rawKey,
      property_label: propertyLabel,
      room_label: room?.room_number ?? null,
      expected_rent: expected,
      actual_amount: actual,
      difference,
      status,
    });
  }

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
      console.error("[recon] failed to save deposits:", dErr);
    }
  }

  const unmatched = unmatchedDeposits(allDeposits, claimedKeys);

  await supabase
    .from("reconciliation_runs")
    .update({
      bank_statement_path: bankPath,
      other_payments_path: otherPath,
      total_expected: totalExpected,
      total_actual: totalActual,
      match_count: matchCount,
      mismatch_count: mismatchCount,
      missing_count: missingCount,
      unmatched_deposits: unmatched,
    })
    .eq("id", runId);

  revalidatePath("/reconciliation");
  redirect(`/reconciliation/${runId}`);
}

// ----------------------------------------------------------------------------
// 2. Post payments: write a payments table row for each matched tenancy.
//    Idempotent — deletes any prior payments for this run first.
// ----------------------------------------------------------------------------

export async function postPayments(formData: FormData) {
  const runId = String(formData.get("run_id") ?? "");
  if (!runId) return;

  const supabase = await createClient();

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
    // Nothing to post — still flip the run to "posted" so the UI updates.
    await supabase
      .from("reconciliation_runs")
      .update({ posted_at: new Date().toISOString() })
      .eq("id", runId);
    revalidatePath("/reconciliation");
    revalidatePath(`/reconciliation/${runId}`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);

  // For each matched deposit:
  //   1) try to insert a payments row with external_ref = the deposit's
  //      Conf# (or synthetic fingerprint). If it already exists from a
  //      prior overlapping bank statement run, ON CONFLICT short-circuits
  //      and we just re-link this deposit to the existing payment.
  //   2) update the deposit row with payment_id so future Unpost knows.
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
      continue;
    }
    let paymentId: string | null = ins?.id ?? null;
    // If ignored (conflict), look up the existing row so we can link.
    if (!paymentId) {
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("external_ref", d.external_ref)
        .maybeSingle();
      paymentId = existing?.id ?? null;
    }
    if (paymentId) {
      await supabase
        .from("reconciliation_deposits")
        .update({ payment_id: paymentId })
        .eq("id", d.id);
    }
  }

  await supabase
    .from("reconciliation_runs")
    .update({ posted_at: new Date().toISOString() })
    .eq("id", runId);

  revalidatePath("/reconciliation");
  revalidatePath(`/reconciliation/${runId}`);
  revalidatePath("/tenants");
}

export async function unpostPayments(formData: FormData) {
  const runId = String(formData.get("run_id") ?? "");
  if (!runId) return;

  const supabase = await createClient();

  // Collect this run's external_refs so we can remove only the payment
  // rows that were created from these deposits.
  const { data: deps } = await supabase
    .from("reconciliation_deposits")
    .select("external_ref")
    .eq("run_id", runId);

  const refs = Array.from(
    new Set(((deps ?? []) as { external_ref: string }[]).map((d) => d.external_ref)),
  );
  if (refs.length > 0) {
    // Only delete payments whose external_ref isn't referenced by any
    // OTHER run's deposits — so overlap with another posted run keeps
    // its payment alive.
    const { data: otherRefs } = await supabase
      .from("reconciliation_deposits")
      .select("external_ref")
      .neq("run_id", runId)
      .in("external_ref", refs);
    const stillReferenced = new Set(
      ((otherRefs ?? []) as { external_ref: string }[]).map((r) => r.external_ref),
    );
    const safeToDelete = refs.filter((r) => !stillReferenced.has(r));
    if (safeToDelete.length > 0) {
      await supabase.from("payments").delete().in("external_ref", safeToDelete);
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
  const { data: objects } = await supabase.storage
    .from("reconciliation")
    .list(id);
  if (objects && objects.length > 0) {
    await supabase.storage
      .from("reconciliation")
      .remove(objects.map((o) => `${id}/${o.name}`));
  }
  await supabase
    .from("payments")
    .delete()
    .eq("reconciliation_run_id", id);
  await supabase.from("reconciliation_runs").delete().eq("id", id);
  revalidatePath("/reconciliation");
  redirect("/reconciliation");
}
