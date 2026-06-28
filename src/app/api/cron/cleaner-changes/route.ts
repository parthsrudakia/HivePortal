/**
 * Evening cron (~8–9pm ET) that drains the debounced cleaner schedule-change
 * queue. Any schedule change made during the day enqueued a row; here we send
 * one "schedule updated" notice per affected cleaner so a day's worth of
 * changes go out together. Scheduled at 01:00 UTC (9pm EDT / 8pm EST).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { flushCleanerScheduleChanges } from "@/lib/cleaner-reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = admin();
  const result = await flushCleanerScheduleChanges(supabase);
  return NextResponse.json(result);
}
