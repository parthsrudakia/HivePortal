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
  aggregateByDescription,
  unmatchedDeposits,
  tenantKey,
  bankPayerNameDisplay,
  type Deposit,
} from "@/lib/reconciliation/parsers";
import { rateForMonthISO, type RentChange } from "@/lib/rent";
import type { SupabaseClient } from "@supabase/supabase-js";

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

// What a tenancy owes in the reconciliation month. Mirrors the Rent Tracker's
// dueForMonth: a tenancy in its starting month with a prorated first_month_rent
// owes that, not a full month — otherwise it would falsely show as a mismatch.
// Bills the rate in effect THAT month (tenancy_rent_history), so reconciling
// an old month is unaffected by rent changes made since.
function expectedForMonth(
  startDate: string,
  monthlyRent: number,
  firstMonthRent: number | null,
  monthStart: string,
  monthEnd: string,
  rentChanges: RentChange[],
): number {
  if (startDate > monthEnd) return 0;
  if (
    startDate >= monthStart &&
    startDate <= monthEnd &&
    firstMonthRent !== null
  ) {
    return firstMonthRent;
  }
  return rateForMonthISO(monthStart, monthlyRent, rentChanges);
}

type TenancyInfo = {
  id: string;
  tenant_id: string | null;
  tenant_name: string;
  pays_as: string | null;
  full_name: string;
  monthly_rent: number;
  first_month_rent: number | null;
  start_date: string;
  property_label: string | null;
  room_label: string | null;
  rent_changes: RentChange[];
  /** Remembered payer keys for this tenant (tenant_payer_aliases). */
  alias_keys: string[];
  /** Rent recorded in the system for this month outside a bank posting. */
  recorded_paid: number;
};

// Every tenancy that overlapped the reconciliation month — including ones that
// ENDED mid-month (status 'ended' with a move_out_date inside the window), which
// the old active-only filter dropped, leaving their payments unattributed.
async function loadMonthTenancies(
  supabase: SupabaseClient,
  monthStart: string,
  monthEnd: string,
): Promise<{ tenancies: TenancyInfo[]; error?: string }> {
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
    first_month_rent: number | null;
    start_date: string;
    move_out_date: string | null;
    tenants: TenantRel | TenantRel[] | null;
    rooms: RoomRel | RoomRel[] | null;
  };
  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, start_date, move_out_date,
       tenants(id, full_name, pays_as),
       rooms(room_number,
             properties(building_name, street_address, unit_number))`,
    )
    .in("status", ["active", "ended"])
    .lte("start_date", monthEnd)
    .or(`move_out_date.is.null,move_out_date.gte.${monthStart}`)
    .returns<TenancyRow[]>();
  if (error) return { tenancies: [], error: error.message };

  // Rent-rate history for these tenancies, so the month bills the rate that
  // was in effect back then rather than today's monthly_rent. Accessed via
  // `as any` because the table post-dates the generated types (rent-data.ts).
  const ids = (data ?? []).map((t) => t.id);
  const changesByTenancy = new Map<string, RentChange[]>();
  if (ids.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data: histRows } = await sb
      .from("tenancy_rent_history")
      .select("tenancy_id, effective_month, monthly_rent")
      .in("tenancy_id", ids);
    for (const r of histRows ?? []) {
      const list = changesByTenancy.get(r.tenancy_id);
      const change = {
        effective_month: r.effective_month,
        monthly_rent: r.monthly_rent,
      };
      if (list) list.push(change);
      else changesByTenancy.set(r.tenancy_id, [change]);
    }
  }

  // Rent already recorded in the system for this month outside a bank
  // posting (manual entries, Zelle recorded on the tenant page, …). These
  // count toward a tenancy's "actual" so a tenant who paid through another
  // channel isn't shown as missing. Bank-posted payments are excluded
  // (external_ref set) — their deposits are already in the run, and counting
  // both would double the money.
  const paidByTenancy = new Map<string, number>();
  if (ids.length > 0) {
    const { data: payRows } = await supabase
      .from("payments")
      .select("tenancy_id, amount")
      .eq("payment_type", "rent")
      .is("external_ref", null)
      .gte("paid_on", monthStart)
      .lte("paid_on", monthEnd)
      .in("tenancy_id", ids);
    for (const p of payRows ?? []) {
      paidByTenancy.set(
        p.tenancy_id,
        (paidByTenancy.get(p.tenancy_id) ?? 0) + Number(p.amount),
      );
    }
  }

  // Remembered payer aliases (operator assigned a deposit to this tenant in
  // an earlier run) — those payer keys match the tenant automatically.
  const tenantIds = [
    ...new Set((data ?? []).map((t) => t.tenant_id).filter(Boolean)),
  ];
  const aliasesByTenant = new Map<string, string[]>();
  if (tenantIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data: aliasRows } = await sb
      .from("tenant_payer_aliases")
      .select("tenant_id, payer_key")
      .in("tenant_id", tenantIds);
    for (const r of aliasRows ?? []) {
      const list = aliasesByTenant.get(r.tenant_id);
      if (list) list.push(r.payer_key);
      else aliasesByTenant.set(r.tenant_id, [r.payer_key]);
    }
  }

  const tenancies = (data ?? [])
    .map((t): TenancyInfo | null => {
      const tenant = one(t.tenants);
      if (!tenant) return null;
      const room = one(t.rooms);
      const property = one(room?.properties ?? null);
      return {
        id: t.id,
        tenant_id: tenant.id,
        tenant_name: tenant.full_name,
        pays_as: tenant.pays_as,
        full_name: tenant.full_name,
        monthly_rent: Number(t.monthly_rent),
        first_month_rent:
          t.first_month_rent != null ? Number(t.first_month_rent) : null,
        start_date: t.start_date,
        property_label: property
          ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
          : null,
        room_label: room?.room_number ?? null,
        rent_changes: changesByTenancy.get(t.id) ?? [],
        alias_keys: aliasesByTenant.get(tenant.id) ?? [],
        recorded_paid: paidByTenancy.get(t.id) ?? 0,
      };
    })
    .filter((t): t is TenancyInfo => t !== null);
  return { tenancies };
}

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

// Every payer key a tenancy answers to: its pays_as/full-name key plus each
// remembered alias of its tenant (operator-assigned in an earlier run).
function keysOf(t: TenancyInfo): string[] {
  return [...new Set([tenantKey(t.pays_as, t.full_name), ...t.alias_keys])];
}

// Pure matcher shared by the initial run and by recompute-after-assign. Sums
// deposits by payer key — plus rent recorded outside a bank posting — and
// lines the total up against each tenancy's expected rent.
function buildMatches(
  deposits: Deposit[],
  tenancies: TenancyInfo[],
  monthStart: string,
  monthEnd: string,
  runId: string,
) {
  const aggregate = aggregateByDescription(deposits);
  const matches: MatchRow[] = [];
  const claimedKeys = new Set<string>();
  const tenancyByKey = new Map<string, string>();
  let totalExpected = 0;
  let totalActual = 0;
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  // Two tenancies can share a payer key (a tenant who moved rooms mid-month,
  // or two tenants with identical names). The deposits are one pot of money —
  // credit it to ONE tenancy (the most recent, deterministically) instead of
  // showing the full sum on every row and double-counting the totals.
  const ordered = [...tenancies].sort((a, b) =>
    b.start_date.localeCompare(a.start_date),
  );
  const keyClaimedBy = new Map<string, string>();
  for (const t of ordered) {
    for (const k of keysOf(t)) {
      if (!keyClaimedBy.has(k)) keyClaimedBy.set(k, t.id);
    }
  }

  for (const t of tenancies) {
    const rawKey = tenantKey(t.pays_as, t.full_name);
    const expected = expectedForMonth(
      t.start_date,
      t.monthly_rent,
      t.first_month_rent,
      monthStart,
      monthEnd,
      t.rent_changes,
    );
    // Sum the deposits under every key this tenancy claims — a tenant can pay
    // under their own name one month and a remembered alias the next.
    let actual = 0;
    for (const k of keysOf(t)) {
      if (keyClaimedBy.get(k) !== t.id) continue;
      const sum = aggregate.get(k) ?? 0;
      if (sum > 0) {
        actual += sum;
        claimedKeys.add(k);
        tenancyByKey.set(k, t.id);
      }
    }
    // Plus rent already recorded in the system for this month outside a bank
    // posting — a tenant who paid through another channel isn't missing.
    actual += t.recorded_paid;

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

    matches.push({
      run_id: runId,
      tenancy_id: t.id,
      tenant_id: t.tenant_id,
      tenant_name: t.tenant_name,
      pays_as: rawKey,
      property_label: t.property_label,
      room_label: t.room_label,
      expected_rent: expected,
      actual_amount: actual,
      difference,
      status,
    });
  }

  const unmatched = unmatchedDeposits(deposits, claimedKeys);
  return {
    matches,
    tenancyByKey,
    unmatched,
    totals: {
      totalExpected,
      totalActual,
      matchCount,
      mismatchCount,
      missingCount,
    },
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

async function recomputeRun(supabase: SupabaseClient, runId: string) {
  const { data: run } = await supabase
    .from("reconciliation_runs")
    .select("month")
    .eq("id", runId)
    .maybeSingle<{ month: string }>();
  if (!run) throw new Error("Run not found.");
  const { start, end } = monthBounds(run.month);

  const { data: depRows, error: depErr } = await supabase
    .from("reconciliation_deposits")
    .select("payer_key, raw_description, amount, deposit_date, external_ref")
    .eq("run_id", runId);
  if (depErr) throw new Error(`Failed to load deposits: ${depErr.message}`);

  const deposits: Deposit[] = (depRows ?? []).map((d) => ({
    description: d.payer_key,
    raw: d.raw_description ?? "",
    amount: Number(d.amount),
    date: d.deposit_date,
    source: "bank",
    externalRef: d.external_ref,
  }));

  const { tenancies, error: tErr } = await loadMonthTenancies(
    supabase,
    start,
    end,
  );
  if (tErr) throw new Error(`Failed to load tenancies: ${tErr}`);

  const { matches, tenancyByKey, unmatched, totals } = buildMatches(
    deposits,
    tenancies,
    start,
    end,
    runId,
  );

  // Re-point each deposit to its (possibly new) tenancy.
  const distinctKeys = Array.from(new Set(deposits.map((d) => d.description)));
  for (const key of distinctKeys) {
    await supabase
      .from("reconciliation_deposits")
      .update({ tenancy_id: tenancyByKey.get(key) ?? null })
      .eq("run_id", runId)
      .eq("payer_key", key);
  }

  // Rewrite matches and run totals.
  await supabase.from("reconciliation_matches").delete().eq("run_id", runId);
  if (matches.length > 0) {
    const { error: mErr } = await supabase
      .from("reconciliation_matches")
      .insert(matches);
    if (mErr) throw new Error(`Failed to rewrite matches: ${mErr.message}`);
  }

  await supabase
    .from("reconciliation_runs")
    .update({
      total_expected: totals.totalExpected,
      total_actual: totals.totalActual,
      match_count: totals.matchCount,
      mismatch_count: totals.mismatchCount,
      missing_count: totals.missingCount,
      unmatched_deposits: unmatched,
    })
    .eq("id", runId);
}

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
