/**
 * Listings bot pass: posts pending inventory changes to the team's Telegram
 * group and fires due reminders (see src/lib/listings-bot/run.ts). Pinged by
 * Supabase pg_cron every minute — only when a change has been quiet for two
 * minutes or a reminder is due — since Vercel Hobby crons are daily-only.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runListingsBot } from "@/lib/listings-bot/run";

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

  return NextResponse.json(await runListingsBot());
}
