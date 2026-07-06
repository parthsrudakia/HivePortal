import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO, formatDate } from "@/lib/date";
import {
  computeLedger,
  buildLedgerEntries,
  type LedgerCharge,
  type RentChange,
  type LedgerAllocation,
} from "@/lib/rent";

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
  status: "active" | "ended" | "upcoming";
  rooms: RoomRel | RoomRel[] | null;
};
type Charge = {
  id: string;
  kind: string;
  amount: number;
  charged_on: string;
  note: string | null;
};
type Allocation = { id: string; kind: string; amount: number; note: string | null; created_at: string };
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
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const today = todayISO();

  const [{ data: tenant }, { data: tenancies }, { data: payments }] =
    await Promise.all([
      supabase
        .from("tenants")
        .select("id, full_name, email, phone")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("tenancies")
        .select(
          `id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date, status,
           rooms(room_number, properties(building_name, street_address, unit_number))`,
        )
        .eq("tenant_id", id)
        .order("start_date", { ascending: false })
        .returns<Tenancy[]>(),
      supabase
        .from("payments")
        .select(
          `id, paid_on, amount, payment_type, notes, tenancy_id,
           tenancies!inner(tenant_id)`,
        )
        .eq("tenancies.tenant_id", id)
        .order("paid_on", { ascending: false })
        .returns<Payment[]>(),
    ]);

  if (!tenant) {
    return new NextResponse("Tenant not found", { status: 404 });
  }

  // Export the active tenancy's ledger, or the most recent ended one so a
  // moved-out tenant's outstanding balance is still exportable.
  const active =
    tenancies?.find((t) => t.status === "active") ??
    tenancies?.find((t) => t.status === "ended") ??
    null;
  if (!active) {
    return new NextResponse("No tenancy to export", { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const [chargeRes, allocRes, rentHistRes] = await Promise.all([
    sb
      .from("tenancy_charges")
      .select("id, kind, amount, charged_on, note")
      .eq("tenancy_id", active.id)
      .order("charged_on", { ascending: false }),
    sb
      .from("credit_allocations")
      .select("id, kind, amount, note, created_at")
      .eq("tenancy_id", active.id)
      .order("created_at", { ascending: false }),
    sb
      .from("tenancy_rent_history")
      .select("effective_month, monthly_rent")
      .eq("tenancy_id", active.id),
  ]);
  const charges = (chargeRes.data ?? []) as Charge[];
  const allocations = (allocRes.data ?? []) as Allocation[];
  const rentChanges = (rentHistRes.data ?? []) as RentChange[];
  const activePayments = (payments ?? []).filter((p) => p.tenancy_id === active.id);

  const ledger = computeLedger(
    active,
    activePayments,
    charges as LedgerCharge[],
    allocations as LedgerAllocation[],
    today,
    rentChanges,
  );
  const entries = buildLedgerEntries(
    active,
    activePayments,
    charges,
    today,
    rentChanges,
  );

  const room = one(active.rooms);
  const p = one(room?.properties ?? null);
  const unit = p
    ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}${
        room?.room_number ? ` · ${room.room_number}` : ""
      }`
    : "—";

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
  const period = `Statement period: ${formatDate(active.start_date)} – ${
    active.move_out_date ? formatDate(active.move_out_date) : "present"
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
    const r = ws.addRow([
      formatDate(e.date),
      e.description,
      e.charge > 0 ? e.charge : null,
      e.payment > 0 ? e.payment : null,
      e.balance,
    ]);
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
