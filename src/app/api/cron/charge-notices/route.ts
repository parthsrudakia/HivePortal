/**
 * Sends "Other" charge emails once their 5-minute correction window is up
 * (see src/lib/charge-notices.ts). Pinged every minute by Supabase pg_cron —
 * only when a notice is due — since Vercel Hobby crons are daily-only.
 */

import { NextResponse, type NextRequest } from "next/server";
import { flushChargeNotices } from "@/lib/charge-notices";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await flushChargeNotices());
}
