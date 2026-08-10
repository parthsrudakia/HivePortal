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
// Building the workbook scales with room/ad count; lift the ceiling off
// Vercel's default so a large export can't get hard-killed mid-write.
export const maxDuration = 60;

type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
  neighborhood: string | null;
  unit_amenities: string[];
  building_amenities: string[];
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
  has_private_bathroom: boolean;
  has_ac: boolean;
  listing_action: Action;
  ads: { url: string; posted_by: string | null }[];
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
  if (room.has_ac) tags.push("AC");
  tags.push(...(p?.unit_amenities ?? []));
  tags.push(...(p?.building_amenities ?? []));
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
       photos_url, has_private_bathroom, has_ac, listing_action,
       properties(building_name, street_address, unit_number, neighborhood,
                  unit_amenities, building_amenities),
       tenancies(status, start_date, move_out_date, tenants(full_name))`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .returns<Omit<Row, "ads">[]>();

  // Attach each room's ads.
  const { data: adRowsData } = await supabase
    .from("room_ads")
    .select("room_id, url, posted_by")
    .order("created_at", { ascending: true });
  const adsByRoom = new Map<string, { url: string; posted_by: string | null }[]>();
  for (const a of (adRowsData ?? []) as {
    room_id: string;
    url: string;
    posted_by: string | null;
  }[]) {
    const list = adsByRoom.get(a.room_id) ?? [];
    list.push({ url: a.url, posted_by: a.posted_by });
    adsByRoom.set(a.room_id, list);
  }
  const withAds: Row[] = (data ?? []).map((r) => ({
    ...r,
    ads: adsByRoom.get(r.id) ?? [],
  }));

  const rooms = filterAndSortRooms(withAds, { sort, dir, posterKeys });

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
    { header: "Ads", key: "ad", width: 40 },
    { header: "Ad Posted", key: "ad_posted", width: 24 },
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

    // A room can have several ads from different people. List every URL
    // (newline-separated so they stay copyable) and the distinct posters.
    const adUrls = r.ads.map((a) => a.url);
    const adPosters = Array.from(
      new Set(
        r.ads.map((a) => a.posted_by?.trim()).filter((n): n is string => !!n),
      ),
    );

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
      ad: adUrls.length ? adUrls.join("\n") : "None",
      ad_posted: adPosters.join(", "),
    });
    if (r.photos_url) row.getCell("photos").font = LINK_FONT;
    if (adUrls.length > 1) row.getCell("ad").alignment = { wrapText: true };
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
