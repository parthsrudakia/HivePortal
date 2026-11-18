/**
 * GET /api/applications/invites/[token]: whether an application invite is
 * usable, for the website's /apply-now page. Requires
 * `Authorization: Bearer $APPLICATIONS_API_KEY`.
 *
 * 200 { status: "valid", invite: { room_label, neighborhood, monthly_rent,
 * expires_at } }, 404 { status: "not_found" }, 410 { status: "expired" |
 * "used" | "cancelled" }. Never returns the street address or unit number.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { agreementsAdmin } from "@/lib/agreement-send";
import { lookupInvite } from "@/lib/application-invites";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const denied = requireBearer(req, "APPLICATIONS_API_KEY");
  if (denied) return denied;

  const { token } = await params;
  const result = await lookupInvite(agreementsAdmin(), token);
  return NextResponse.json(result.body, {
    status: result.httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}
