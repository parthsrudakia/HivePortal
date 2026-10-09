/**
 * Emergency-contact request emails for every active tenant in Singh Tower and
 * MetroVue. Each tenant gets their own form link (/emergency-contact/<token>);
 * the emergency_contacts row is created on first run and reused after.
 *
 * Dry run (default): lists who would be emailed. Sends nothing.
 *   npx tsx --env-file=.env.local scripts/send-emergency-contact.ts
 *
 * Test: one email to an address you own, using the first tenant's real link
 * (clear any test submission before the real send — see --reset-test).
 *   npx tsx --env-file=.env.local scripts/send-emergency-contact.ts --test you@example.com
 *
 * Real send: every tenant not yet emailed. Safe to rerun.
 *   npx tsx --env-file=.env.local scripts/send-emergency-contact.ts --send
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { sendEmergencyContactRequest } from "../src/lib/email";
import { emergencyContactUrl } from "../src/lib/emergency-contact";

const BUILDINGS = /singh|metro/i;

const args = process.argv.slice(2);
const testTo = args.includes("--test") ? args[args.indexOf("--test") + 1] : null;
const realSend = args.includes("--send");
const resetTest = args.includes("--reset-test");

const sb = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Target = {
  tenantId: string;
  name: string;
  email: string | null;
  building: string;
  unit: string;
};

const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
const num = (s: string) => parseInt(s.replace(/\D/g, ""), 10) || 0;

async function targets(): Promise<Target[]> {
  const { data, error } = await sb
    .from("tenancies")
    .select(
      "tenants(id, full_name, email), rooms!inner(room_number, properties!inner(building_name, unit_number))",
    )
    .eq("status", "active");
  if (error) throw error;
  const out: Target[] = [];
  for (const t of data) {
    const room = one(t.rooms);
    const p = one(room?.properties ?? null);
    const tenant = one(t.tenants);
    if (!p || !tenant || !BUILDINGS.test(p.building_name ?? "")) continue;
    out.push({
      tenantId: tenant.id,
      name: tenant.full_name,
      email: tenant.email?.trim() || null,
      building: p.building_name ?? "",
      unit: p.unit_number,
    });
  }
  return out.sort(
    (a, b) => a.building.localeCompare(b.building) || num(a.unit) - num(b.unit) || a.name.localeCompare(b.name),
  );
}

/** Create the tenant's row if missing; returns token + request state. */
async function ensureRow(tenantId: string) {
  const { error } = await sb
    .from("emergency_contacts")
    .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true });
  if (error) throw error;
  const { data, error: e2 } = await sb
    .from("emergency_contacts")
    .select("id, token, requested_at, submitted_at")
    .eq("tenant_id", tenantId)
    .single();
  if (e2) throw e2;
  return data;
}

const firstName = (full: string) => full.trim().split(/\s+/)[0];
const unitLabel = (t: Target) => `${t.building} ${t.unit}`;

async function main() {
  const list = await targets();

  if (resetTest) {
    // Clears answers on the first tenant's row (the one --test links to).
    const row = await ensureRow(list[0].tenantId);
    const { error } = await sb
      .from("emergency_contacts")
      .update({ contact_name: null, relationship: null, contact_email: null, contact_phone: null, submitted_at: null })
      .eq("id", row.id);
    if (error) throw error;
    console.log(`Cleared test answers on ${list[0].name}'s row.`);
    return;
  }

  if (testTo) {
    const t = list[0];
    const row = await ensureRow(t.tenantId);
    const url = emergencyContactUrl(row.token);
    const res = await sendEmergencyContactRequest(
      testTo,
      { firstName: firstName(t.name), unitLabel: unitLabel(t), url },
      `TEST · ${unitLabel(t)} · ${t.name}`,
    );
    console.log(`Test to ${testTo} (as ${t.name}, ${unitLabel(t)}):`, res);
    console.log("Form link:", url);
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const t of list) {
    if (!t.email) {
      console.log(`NO EMAIL   ${unitLabel(t)}  ${t.name}`);
      skipped++;
      continue;
    }
    if (!realSend) {
      console.log(`WOULD SEND ${unitLabel(t)}  ${t.name} <${t.email}>`);
      continue;
    }
    const row = await ensureRow(t.tenantId);
    if (row.requested_at || row.submitted_at) {
      console.log(`ALREADY    ${unitLabel(t)}  ${t.name}`);
      skipped++;
      continue;
    }
    const res = await sendEmergencyContactRequest(
      t.email,
      { firstName: firstName(t.name), unitLabel: unitLabel(t), url: emergencyContactUrl(row.token) },
      `${unitLabel(t)} · ${t.name}`,
    );
    if (!res.ok) {
      console.log(`FAILED     ${unitLabel(t)}  ${t.name}`, res);
      failed++;
      continue;
    }
    const { error } = await sb
      .from("emergency_contacts")
      .update({ requested_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) throw error;
    console.log(`${"queued" in res && res.queued ? "QUEUED" : "SENT"}       ${unitLabel(t)}  ${t.name}`);
    sent++;
  }
  console.log(`\n${list.length} tenants · ${realSend ? `${sent} sent · ` : "dry run · "}${skipped} skipped · ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
