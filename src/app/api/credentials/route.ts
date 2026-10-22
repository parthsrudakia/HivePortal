/**
 * Read-only credentials API — `GET /api/credentials`.
 *
 * Returns stored logins (service, username, decrypted password, login URL,
 * account number) for internal scripts and agents. Auth is a static bearer
 * token (`CREDENTIALS_API_KEY`) separate from every other API key — this
 * endpoint returns plaintext secrets, so no other token may unlock it.
 *
 * Query params (combine freely):
 *   ?property_id=  credentials attached to one property
 *   ?category=     payment_portal | maintenance_portal | utility | internet
 *                  | building_login | other
 *   ?q=            case-insensitive substring over service, username, owner
 *
 * Passwords are encrypted at rest and decrypted per row via the service-role
 * function; every credential returned is written to `credential_access_log`
 * with action 'api' (accessed_by null), so API reads show up in the same
 * trail as portal reveals. Docs: /developers — keep in sync when this changes.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { one } from "@/lib/relations";
import { requireBearer } from "@/lib/api-auth";
import { unitLabel } from "@/lib/unit-label";

export const dynamic = "force-dynamic";

type Category = Database["public"]["Enums"]["credential_category"];
const CATEGORIES: Category[] = [
  "payment_portal",
  "maintenance_portal",
  "utility",
  "internet",
  "building_login",
  "other",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type PropertyRel = {
  id: string;
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type Row = {
  id: string;
  category: Category;
  service_name: string;
  property_id: string | null;
  username: string | null;
  login_url: string | null;
  account_number: string | null;
  owner_label: string | null;
  notes: string | null;
  updated_at: string;
  properties: PropertyRel | PropertyRel[] | null;
};

export async function GET(req: Request) {
  const denied = requireBearer(req, "CREDENTIALS_API_KEY");
  if (denied) return denied;

  const url = new URL(req.url);
  const propertyId = url.searchParams.get("property_id");
  const category = url.searchParams.get("category");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  if (propertyId && !UUID_RE.test(propertyId)) {
    return NextResponse.json(
      { error: "property_id must be a UUID" },
      { status: 400 },
    );
  }
  if (category && !CATEGORIES.includes(category as Category)) {
    return NextResponse.json(
      { error: `category must be one of: ${CATEGORIES.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = admin();
  let query = supabase
    .from("credentials")
    .select(
      `id, category, service_name, property_id, username, login_url,
       account_number, owner_label, notes, updated_at,
       properties(id, building_name, street_address, unit_number)`,
    )
    .order("service_name");
  if (propertyId) query = query.eq("property_id", propertyId);
  if (category) query = query.eq("category", category as Category);

  const { data, error } = await query.returns<Row[]>();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).filter(
    (c) =>
      !q ||
      c.service_name.toLowerCase().includes(q) ||
      (c.username ?? "").toLowerCase().includes(q) ||
      (c.owner_label ?? "").toLowerCase().includes(q),
  );

  // Decrypt only the rows being returned. A decrypt failure fails the whole
  // request rather than silently handing back a null password.
  let credentials;
  try {
    credentials = await Promise.all(
      rows.map(async (c) => {
        const { data: pw, error: pwErr } = await supabase.rpc(
          "credential_password_internal",
          { cred_id: c.id },
        );
        if (pwErr) throw new Error(pwErr.message);
        const p = one(c.properties);
        return {
          id: c.id,
          category: c.category,
          service_name: c.service_name,
          property_id: c.property_id,
          unit: p ? unitLabel(p) : null,
          username: c.username,
          password: (pw as string | null) ?? null,
          login_url: c.login_url,
          account_number: c.account_number,
          owner: c.owner_label,
          notes: c.notes,
          updated_at: c.updated_at,
        };
      }),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "decrypt failed" },
      { status: 500 },
    );
  }

  if (credentials.length > 0) {
    const { error: logErr } = await supabase
      .from("credential_access_log")
      .insert(
        credentials.map((c) => ({
          credential_id: c.id,
          action: "api",
          accessed_by: null,
        })),
      );
    // Secrets don't leave without an audit row.
    if (logErr) {
      return NextResponse.json(
        { error: `access log failed: ${logErr.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ count: credentials.length, credentials });
}
