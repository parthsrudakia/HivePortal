import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import { ACTION_LABELS, type Action } from "../constants";
import {
  parseInventoryParams,
  resolvePosterKeys,
  filterAndSortRooms,
} from "@/lib/inventory-filter";

export const dynamic = "force-dynamic";

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  has_gym: boolean;
  has_elevator: boolean;
  has_parking: boolean;
  has_doorman: boolean;
  has_rooftop: boolean;
  has_lounge: boolean;
  laundry_in_building: boolean;
  in_unit_laundry: boolean;
};

type TenantRel = { full_name: string };
type TenancyRel = {
  status: "active" | "ended" | "upcoming";
  start_date: string;
  move_out_date: string | null;
  tenants: TenantRel | TenantRel[] | null;
};

type Row = {
  id: string;
  room_number: string | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  available_from: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  photos_url: string | null;
  has_ac: boolean;
  has_private_bathroom: boolean;
  listing_action: Action;
  ad_url: string | null;
  ad_boosted: boolean;
  ad_posted_by: string | null;
  properties: PropertyRel | PropertyRel[] | null;
  tenancies: TenancyRel[] | null;
};

const LINK_FONT = { color: { argb: "FF0563C1" }, underline: true } as const;

function prettyDate(iso: string | null): string {
  if (!iso) return "Available now";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function amenitiesFor(room: Row, p: PropertyRel | null): string {
  const tags: string[] = [];
  if (room.has_private_bathroom) tags.push("Private bath");
  if (p?.has_gym) tags.push("Gym");
  if (p?.has_elevator) tags.push("Elevator");
  if (p?.has_doorman) tags.push("Doorman");
  if (p?.has_parking) tags.push("Parking");
  if (p?.has_rooftop) tags.push("Rooftop");
  if (p?.has_lounge) tags.push("Lounge");
  if (p?.in_unit_laundry) tags.push("In-unit laundry");
  else if (p?.laundry_in_building) tags.push("Laundry");
  return tags.join(", ");
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const today = todayISO();

  // Mirror the table's current filter/sort so the sheet matches what's on screen.
  const { sort, dir, poster } = parseInventoryParams(
    new URL(request.url).searchParams,
  );
  const posterKeys = await resolvePosterKeys(supabase, poster);

  const { data } = await supabase
    .from("rooms")
    .select(
      `id, room_number, status, available_from, base_rent, bundle_fee, total_rent,
       photos_url, has_ac, has_private_bathroom, listing_action, ad_url,
       ad_boosted, ad_posted_by,
       properties(building_name, street_address, unit_number, neighborhood,
                  has_gym, has_elevator, has_parking, has_doorman, has_rooftop,
                  has_lounge, laundry_in_building, in_unit_laundry),
       tenancies(status, start_date, move_out_date, tenants(full_name))`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .returns<Row[]>();

  const rooms = filterAndSortRooms(data ?? [], { sort, dir, posterKeys });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Inventory");

  ws.columns = [
    { header: "Unit", key: "unit", width: 30 },
    { header: "Neighborhood", key: "neighborhood", width: 16 },
    { header: "Room", key: "room", width: 10 },
    { header: "Available", key: "available", width: 16 },
    { header: "Rent", key: "rent", width: 12 },
    { header: "Services", key: "services", width: 12 },
    { header: "Total", key: "total", width: 12 },
    { header: "Amenities", key: "amenities", width: 40 },
    { header: "Photos", key: "photos", width: 10 },
    { header: "Tenant", key: "tenant", width: 24 },
    { header: "Listing action", key: "listing_action", width: 16 },
    { header: "Ad", key: "ad", width: 10 },
    { header: "Boosted", key: "boosted", width: 10 },
    { header: "Ad Posted", key: "ad_posted", width: 20 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rooms) {
    const p = one(r.properties);
    const unit = p
      ? `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`
      : "—";

    const ordered = (r.tenancies ?? [])
      .slice()
      .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
    const featured =
      ordered.find((t) => t.status === "active" && t.move_out_date) ??
      ordered.find((t) => t.status === "ended");
    const tenantName = featured ? one(featured.tenants)?.full_name ?? "" : "";

    const row = ws.addRow({
      unit,
      neighborhood: p?.neighborhood ?? "",
      room: (r.room_number ?? "").replace(/^room\s+/i, ""),
      available: prettyDate(r.available_from),
      rent: r.base_rent ?? null,
      services: r.bundle_fee ?? null,
      total: r.total_rent ?? null,
      amenities: amenitiesFor(r, p),
      photos: r.photos_url ? { text: "Link", hyperlink: r.photos_url } : "",
      tenant: tenantName,
      listing_action: ACTION_LABELS[r.listing_action] ?? r.listing_action,
      ad: r.ad_url ? { text: "Link", hyperlink: r.ad_url } : "None",
      boosted: r.ad_boosted ? "Yes" : "No",
      ad_posted: r.ad_posted_by ?? "",
    });
    if (r.photos_url) row.getCell("photos").font = LINK_FONT;
    if (r.ad_url) row.getCell("ad").font = LINK_FONT;
  }

  for (const key of ["rent", "services", "total"] as const) {
    ws.getColumn(key).numFmt = "$#,##0";
  }

  // Legend — explains the "Services" bundle.
  ws.addRow({});
  const legend = ws.addRow({
    unit: "Services = Wifi + Electricity + Gas + Cleaning Services",
  });
  ws.mergeCells(`A${legend.number}:E${legend.number}`);
  legend.getCell("unit").font = { italic: true, color: { argb: "FF8A8378" } };

  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="hive-inventory-full-${today}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
