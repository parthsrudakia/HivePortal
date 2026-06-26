import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildInventorySheet } from "@/lib/inventory-sheet";
import {
  parseInventoryParams,
  resolvePosterKeys,
} from "@/lib/inventory-filter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();

  // Mirror the table's current filter/sort so the sheet matches what's on screen.
  const { sort, dir, poster } = parseInventoryParams(
    new URL(request.url).searchParams,
  );
  const posterKeys = await resolvePosterKeys(supabase, poster);
  const { buffer, filename } = await buildInventorySheet(supabase, {
    sort,
    dir,
    posterKeys,
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
