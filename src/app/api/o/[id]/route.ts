/**
 * Email open-tracking pixel — `GET /api/o/<trackId>`.
 *
 * Public (no auth; /api is outside the login proxy). Always answers with a
 * 1x1 transparent GIF, whatever the id, so a bad or unknown id reveals
 * nothing. A valid id records an open on its email_log row via
 * record_email_open. Never cached, so every load reaches us.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { TRANSPARENT_GIF } from "@/lib/email-tracking";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gif(): Response {
  return new Response(new Uint8Array(TRANSPARENT_GIF), {
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (UUID.test(id)) {
    try {
      const sb = createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const { error } = await sb.rpc("record_email_open", { p_track_id: id });
      if (error) console.error("[email-open] record failed", error.message);
    } catch (e) {
      console.error("[email-open] record failed", e);
    }
  }
  return gif();
}
