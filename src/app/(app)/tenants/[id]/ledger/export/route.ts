import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO, formatDate } from "@/lib/date";
import {
  computeTenantLedger,
  buildTenantLedgerEntries,
  type RentChange,
  type TenancyLedgerInput,
} from "@/lib/rent";
import { ledgerRows } from "@/lib/rent-data";

export const dynamic = "force-dynamic";
// Building the workbook scales with ledger-entry count; lift the ceiling off
// Vercel's default so a large export can't get hard-killed mid-write.
export const maxDuration = 60;

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type RoomRel = {
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};
type Tenancy = {
  id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  paused_at: string | null;
  status: "active" | "ended" | "upcoming";
  rooms: RoomRel | RoomRel[] | null;
};
type Charge = {
  id: string;
  kind: string;
  amount: number;
  charged_on: string;
  note: string | null;
  tenancy_id: string;
};
type Allocation = {
  id: string;
  kind: string;
  amount: number;
  note: string | null;
  created_at: string;
  tenancy_id: string;
};

function unitLabel(t: Tenancy): string {
  const room = one(t.rooms);
  const p = one(room?.properties ?? null);
  return p
    ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}${
        room?.room_number ? ` · ${room.room_number}` : ""
      }`
    : "—";
}
type Payment = {
  id: string;
  paid_on: string;
  amount: number;
  payment_type: string;
  notes: string | null;
  tenancy_id: string;
};

const MONEY_FMT = "$#,##0.00";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const today = todayISO();
  // Bill links in the sheet must be absolute (Excel has no "current site"), so
  // anchor them on the portal the file was downloaded from.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || new URL(req.url).origin;

  // Ledger inputs are must-succeed reads: a failed query throws rather than
  // exporting a statement with charges or payments missing.
  const [{ data: tenant }, tenancies, payments] = await Promise.all([
    supabase
      .from("tenants")
      .select("id, full_name, email, phone")
      .eq("id", id)
      .maybeSingle(),
    ledgerRows("tenancies", () =>
      supabase
        .from("tenancies")
        .select(
          `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, paused_at, status,
           rooms(room_number, properties(building_name, street_address, unit_number))`,
        )
        .eq("tenant_id", id)
        .order("start_date", { ascending: false })
        .returns<Tenancy[]>(),
    ),
    ledgerRows("payments", () =>
      supabase
        .from("payments")
        .select(
          `id, paid_on, amount, payment_type, notes, tenancy_id,
           tenancies!inner(tenant_id)`,
        )
        .eq("tenancies.tenant_id", id)
        .order("paid_on", { ascending: false })
        .returns<Payment[]>(),
    ),
  ]);

  if (!tenant) {
    return new NextResponse("Tenant not found", { status: 404 });
  }

  // One statement per tenant: every tenancy's charges and payments on the
  // same running balance, so a room change never splits the export.
  const all = tenancies;
  if (all.length === 0) {
    return new NextResponse("No tenancy to export", { status: 400 });
  }
  const ids = all.map((t) => t.id);

  const [charges, allocations, rentChanges]: [
    Charge[],
    Allocation[],
    (RentChange & { tenancy_id: string })[],
  ] = await Promise.all([
    ledgerRows("charges", () =>
      supabase
        .from("tenancy_charges")
        .select("id, kind, amount, charged_on, note, tenancy_id")
        .in("tenancy_id", ids)
        .order("charged_on", { ascending: false }),
    ),
    ledgerRows("credit allocations", () =>
      supabase
        .from("credit_allocations")
        .select("id, kind, amount, note, created_at, tenancy_id")
        .in("tenancy_id", ids)
        .order("created_at", { ascending: false }),
    ),
    ledgerRows("rent history", () =>
      supabase
        .from("tenancy_rent_history")
        .select("effective_month, monthly_rent, tenancy_id")
        .in("tenancy_id", ids),
    ),
  ]);

  const inputs: TenancyLedgerInput[] = all.map((t) => ({
    id: t.id,
    tenancy: t,
    unitLabel: unitLabel(t),
    payments: payments.filter((p) => p.tenancy_id === t.id),
    charges: charges.filter((c) => c.tenancy_id === t.id),
    allocations: allocations.filter((a) => a.tenancy_id === t.id),
    rentChanges: rentChanges.filter((r) => r.tenancy_id === t.id),
  }));
  const ledger = computeTenantLedger(inputs, today);
  const entries = buildTenantLedgerEntries(inputs, today);

  // Header: the current room first, then every earlier one; the statement
  // spans from the earliest move-in to the latest move-out (or present).
  const current =
    all.find((t) => t.status === "active") ??
    all.find((t) => t.status === "upcoming") ??
    all[0];
  const unit =
    all.length === 1
      ? unitLabel(current)
      : [current, ...all.filter((t) => t.id !== current.id)]
          .map(unitLabel)
          .join(" · previously ");
  const firstStart = all
    .map((t) => t.start_date)
    .sort()[0];
  const open = all.some((t) => !t.move_out_date);
  const lastEnd = open
    ? null
    : all
        .map((t) => t.move_out_date as string)
        .sort()
        .at(-1) ?? null;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Hive Portal";
  const ws = wb.addWorksheet("Ledger");
  ws.columns = [
    { key: "date", width: 14 },
    { key: "description", width: 48 },
    { key: "charge", width: 14 },
    { key: "payment", width: 14 },
    { key: "balance", width: 14 },
  ];

  const title = ws.addRow([tenant.full_name]);
  title.font = { size: 16, bold: true };
  ws.addRow([unit]).font = { color: { argb: "FF8A8378" } };
  const period = `Statement period: ${formatDate(firstStart)} – ${
    lastEnd ? formatDate(lastEnd) : "present"
  }`;
  ws.addRow([period]).font = { color: { argb: "FF8A8378" } };
  ws.addRow([`Generated: ${formatDate(today)}`]).font = {
    color: { argb: "FF8A8378" },
  };
  ws.addRow([]);

  // ---- Summary ----
  const summaryHeader = ws.addRow(["Summary"]);
  summaryHeader.font = { size: 12, bold: true };
  const summaryRows: Array<[string, number]> = [
    ["Security deposit", ledger.deposit.owed],
    ["Late fees", ledger.lateFee.owed],
    ["Rent charged", ledger.rent.owed],
  ];
  if (ledger.other.owed > 0.005) summaryRows.push(["Other charges", ledger.other.owed]);
  for (const [label, amount] of summaryRows) {
    const r = ws.addRow([label, "", "", "", amount]);
    r.getCell(5).numFmt = MONEY_FMT;
  }
  const credit = ledger.netBalance < -0.005;
  const balRow = ws.addRow([
    credit ? "Account credit" : "Balance due",
    "",
    "",
    "",
    credit ? -ledger.netBalance : ledger.netBalance,
  ]);
  balRow.font = { bold: true };
  balRow.getCell(5).numFmt = MONEY_FMT;
  balRow.getCell(5).font = {
    bold: true,
    color: { argb: credit ? "FF9A6F08" : "FFB91C1C" },
  };
  ws.addRow([]);

  // ---- Running ledger ----
  ws.addRow(["Ledger"]).font = { size: 12, bold: true };
  const head = ws.addRow(["Date", "Description", "Charge", "Payment", "Balance"]);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE8E3DB" },
    };
  });
  for (const e of entries) {
    const description = e.unit ? `${e.description} (${e.unit})` : e.description;
    const r = ws.addRow([
      formatDate(e.date),
      // Same as the portal ledger: a utility overcharge links to the bill
      // behind it, so the statement in the spreadsheet is one click away.
      e.billId
        ? { text: description, hyperlink: `${origin}/utilities?bill=${e.billId}` }
        : description,
      e.charge > 0 ? e.charge : null,
      e.payment > 0 ? e.payment : null,
      e.balance,
    ]);
    if (e.billId) {
      r.getCell(2).font = { color: { argb: "FF9A6F08" }, underline: true };
    }
    r.getCell(3).numFmt = MONEY_FMT;
    r.getCell(4).numFmt = MONEY_FMT;
    r.getCell(5).numFmt = MONEY_FMT;
  }

  const buffer = await wb.xlsx.writeBuffer();
  // e.g. "Ledger_Filippo-Curioni.xlsx" — keep the tenant's name readable,
  // just make it filename-safe (spaces/punctuation → hyphens).
  const nameSafe =
    tenant.full_name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "tenant";
  const filename = `Ledger_${nameSafe}.xlsx`;
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
