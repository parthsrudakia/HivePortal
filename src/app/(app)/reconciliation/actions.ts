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
  if (bankResult.deposits.length === 0) {
    return {
      error:
        "No deposit rows found in the bank file. Check the file has 'Description' and 'Amount' columns and at least one positive-amount row.",
    };
  }

  let allDeposits: Deposit[] = bankResult.deposits;
  if (otherFile instanceof File && otherFile.size > 0) {
    try {
      otherResult = await parseOtherFile(otherFile);
    } catch (e) {
      return {
        error: `Couldn't read other-payments file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
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

  // 3) Create the run (preview state, posted_at = null).
  const { data: runIns, error: runErr } = await supabase
    .from("reconciliation_runs")
    .insert({ month })
    .select("id")
    .single();
  if (runErr || !runIns) {
    return { error: runErr?.message ?? "Failed to create run." };
  }
  const runId = runIns.id;

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

  // 5) Build per-tenant matches.
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
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;
  let totalExpected = 0;
  let totalActual = 0;

  for (const t of tenancyRows) {
    const tenant = one(t.tenants);
    if (!tenant) continue;

    const rawKey = (tenant.pays_as ?? tenant.full_name).trim().toLowerCase();
    const expected = Number(t.monthly_rent);
    const actual = aggregate.get(rawKey) ?? 0;
    if (actual > 0) claimedKeys.add(rawKey);

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

  // Cancel any prior posting for this run.
  await supabase
    .from("payments")
    .delete()
    .eq("reconciliation_run_id", runId);

  const { data: run, error: rErr } = await supabase
    .from("reconciliation_runs")
    .select("id, month")
    .eq("id", runId)
    .maybeSingle();
  if (rErr || !run) {
    throw new Error(rErr?.message ?? "Run not found.");
  }

  const { data: matches, error: mErr } = await supabase
    .from("reconciliation_matches")
    .select("tenancy_id, actual_amount, status")
    .eq("run_id", runId)
    .gt("actual_amount", 0);
  if (mErr) {
    throw new Error(mErr.message);
  }

  const { start } = monthBounds(run.month);
  const paidOn = start;
  const stamp = new Date().toISOString().slice(0, 10);
  type Payment = {
    tenancy_id: string;
    paid_on: string;
    amount: number;
    payment_type: "rent";
    method: string;
    notes: string;
    reconciliation_run_id: string;
  };
  const payments: Payment[] = (matches ?? [])
    .filter((m): m is { tenancy_id: string; actual_amount: number; status: string } =>
      Boolean(m.tenancy_id),
    )
    .map((m) => ({
      tenancy_id: m.tenancy_id,
      paid_on: paidOn,
      amount: Number(m.actual_amount),
      payment_type: "rent",
      method: "Reconciliation",
      notes: `Posted from reconciliation run on ${stamp}`,
      reconciliation_run_id: runId,
    }));

  if (payments.length > 0) {
    const { error: pErr } = await supabase.from("payments").insert(payments);
    if (pErr) {
      throw new Error(`Failed to insert payments: ${pErr.message}`);
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
  await supabase
    .from("payments")
    .delete()
    .eq("reconciliation_run_id", runId);
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
