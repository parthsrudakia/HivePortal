/**
 * Builds the "Shareable Sheet" — the public-facing inventory spreadsheet of
 * rooms you can list right now (available today) plus rooms scheduled to open
 * up. Shared by the web download route (`/inventory/export`, RLS client) and
 * the Telegram bot (service-role client) so both produce an identical sheet.
 */

import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { todayISO } from "@/lib/date";
import {
  filterAndSortRooms,
  DEFAULT_VIEW,
  type InventoryView,
} from "@/lib/inventory-filter";

type PropertyRel = {
  cross_street: string | null;
  neighborhood: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  // Carried for filter/sort parity with the inventory table (not displayed).
  building_name: string | null;
  street_address: string;
  unit_number: string;
  unit_amenities: string[];
  building_amenities: string[];
};

type Row = {
  id: string;
  // Carried only for sort parity with the inventory table (tiebreak) — not
  // displayed in the shareable sheet.
  room_number: string | null;
  status: "occupied" | "available" | "reserved" | "maintenance";
  available_from: string | null;
  base_rent: number | null;
  bundle_fee: number | null;
  total_rent: number | null;
  photos_url: string | null;
  has_private_bathroom: boolean;
  has_ac: boolean;
  // Carried only for filter parity with the inventory table (poster filter) —
  // not displayed in the shareable sheet.
  ads: { posted_by: string | null }[];
  properties: PropertyRel | PropertyRel[] | null;
};

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

/**
 * Query the listable inventory and render it into an .xlsx workbook.
 * Accepts any Supabase client (RLS-scoped server client or service-role admin)
 * — the result is identical because the inventory rows aren't user-scoped.
 * Returns the file bytes plus a dated filename and the room count.
 *
 * Pass `view` to filter + sort the rooms exactly like the inventory table
 * (poster / New-York filters, sort column + direction); omit it (e.g. the
 * Telegram bot) for the default: every listable room, available-date ascending.
 */
export async function buildInventorySheet(
  supabase: SupabaseClient<Database>,
  view: InventoryView = DEFAULT_VIEW,
): Promise<{ buffer: Buffer; filename: string; count: number }> {
  const today = todayISO();

  const { data } = await supabase
    .from("rooms")
    .select(
      `id, room_number, status, available_from, base_rent, bundle_fee, total_rent,
       photos_url, has_private_bathroom, has_ac,
       properties(cross_street, neighborhood, bedrooms, bathrooms,
                  building_name, street_address, unit_number,
                  unit_amenities, building_amenities)`,
    )
    .or(
      `status.eq.available,and(status.eq.occupied,available_from.gte.${today})`,
    )
    .eq("pending_tenant", false)
    .returns<Omit<Row, "ads">[]>();

  // Attach each room's ad posters for the poster filter. Only fetched when a
  // poster filter is active.
  const adsByRoom = new Map<string, { posted_by: string | null }[]>();
  if (view.posterKeys) {
    const { data: adRowsData } = await supabase
      .from("room_ads")
      .select("room_id, posted_by");
    for (const a of adRowsData ?? []) {
      const list = adsByRoom.get(a.room_id) ?? [];
      list.push({ posted_by: a.posted_by });
      adsByRoom.set(a.room_id, list);
    }
  }
  const withAds: Row[] = (data ?? []).map((r) => ({
    ...r,
    ads: adsByRoom.get(r.id) ?? [],
  }));

  const rooms = filterAndSortRooms(withAds, view);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Inventory");

  ws.columns = [
    { header: "Cross Street", key: "cross_street", width: 26 },
    { header: "Neighborhood", key: "neighborhood", width: 18 },
    { header: "Photos", key: "photos", width: 12 },
    { header: "Availability", key: "availability", width: 16 },
    { header: "Rent", key: "rent", width: 12 },
    { header: "Services", key: "services", width: 12 },
    { header: "Total", key: "total", width: 12 },
    { header: "Amenities", key: "amenities", width: 40 },
    { header: "Bedrooms", key: "bedrooms", width: 12 },
    { header: "Bathrooms", key: "bathrooms", width: 12 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rooms) {
    const p = one(r.properties);
    const row = ws.addRow({
      cross_street: p?.cross_street ?? "",
      neighborhood: p?.neighborhood ?? "",
      // Show "Link" text hyperlinked to the actual photos URL.
      photos: r.photos_url ? { text: "Link", hyperlink: r.photos_url } : "",
      availability: prettyDate(r.available_from),
      rent: r.base_rent ?? null,
      services: r.bundle_fee ?? null,
      total: r.total_rent ?? null,
      amenities: amenitiesFor(r, p),
      bedrooms: p?.bedrooms ?? null,
      bathrooms: p?.bathrooms ?? null,
    });
    if (r.photos_url) {
      row.getCell("photos").font = {
        color: { argb: "FF0563C1" },
        underline: true,
      };
    }
  }

  for (const key of ["rent", "services", "total"] as const) {
    ws.getColumn(key).numFmt = "$#,##0";
  }

  // Legend — explains the "Services" bundle for recipients of the shared sheet.
  ws.addRow({});
  const legend = ws.addRow({
    cross_street:
      "Services = Wifi + Electricity + Gas + Cleaning Services + Amenity Fees",
  });
  ws.mergeCells(`A${legend.number}:E${legend.number}`);
  legend.getCell("cross_street").font = {
    italic: true,
    color: { argb: "FF8A8378" },
  };

  ws.views = [{ state: "frozen", ySplit: 1 }];

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    filename: `hive-inventory-${today}.xlsx`,
    count: rooms.length,
  };
}
