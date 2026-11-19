/**
 * POST /api/applications/complete: the website hands back a paid application
 * that came in through an invite, and the portal sends the agreement.
 * Requires `Authorization: Bearer $APPLICATIONS_API_KEY`.
 *
 * Body: { token, full_name, email, phone, start_date, end_date,
 * website_application_id }. Rent, deposit and room come from the invite; the
 * agreement goes to the invite's email. Idempotent: a repeat call for the
 * same application returns { status: "already_sent" } and sends nothing.
 *
 * 200 sent | already_sent; 400 invalid_request | invalid_dates; 404
 * not_found; 410 expired | cancelled | used; 409 in_progress and 502
 * send_failed are worth retrying.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { agreementsAdmin } from "@/lib/agreement-send";
import { completeInvite } from "@/lib/application-invites";

export const dynamic = "force-dynamic";
// Generating the PDF and confirming the send can take a while.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const denied = requireBearer(req, "APPLICATIONS_API_KEY");
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, status: "invalid_request", error: "Body must be JSON." },
      { status: 400 },
    );
  }
  const result = await completeInvite(agreementsAdmin(), body);
  return NextResponse.json(result.body, {
    status: result.httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}
