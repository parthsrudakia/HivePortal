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
 *
 * Links are valid for 48 hours. Every send rotates the token, so an older link
 * dies the moment a new one goes out. To re-send tenants whose link expired
 * without a response, add --resend-expired to --send.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { sendEmergencyContactRequest } from "../src/lib/email";
import { randomUUID } from "node:crypto";
import {
  emergencyContactUrl,
  linkActive,
  linkExpiresAt,
} from "../src/lib/emergency-contact";

const BUILDINGS = /singh|metro/i;

const args = process.argv.slice(2);
const testTo = args.includes("--test") ? args[args.indexOf("--test") + 1] : null;
const realSend = args.includes("--send");
const resetTest = args.includes("--reset-test");
const resendExpired = args.includes("--resend-expired");

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
    .select("id, token, requested_at, submitted_at, expires_at")
    .eq("tenant_id", tenantId)
    .single();
  if (e2) throw e2;
  return data;
}

/** Fresh token + 48h expiry; returns the new form URL. */
async function issueLink(rowId: string): Promise<{ url: string; expiresAt: string }> {
  const token = randomUUID();
  const expiresAt = linkExpiresAt();
  const { error } = await sb
    .from("emergency_contacts")
    .update({ token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  if (error) throw error;
  return { url: emergencyContactUrl(token), expiresAt };
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
    const { url, expiresAt } = await issueLink(row.id);
    const res = await sendEmergencyContactRequest(
      testTo,
      { firstName: firstName(t.name), unitLabel: unitLabel(t), url },
      `TEST · ${unitLabel(t)} · ${t.name}`,
    );
    console.log(`Test to ${testTo} (as ${t.name}, ${unitLabel(t)}):`, res);
    console.log("Form link:", url);
    console.log("Expires:  ", new Date(expiresAt).toLocaleString("en-US", { timeZone: "America/New_York" }), "ET");
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
    if (row.submitted_at) {
      console.log(`ANSWERED   ${unitLabel(t)}  ${t.name}`);
      skipped++;
      continue;
    }
    if (row.requested_at && (linkActive(row.expires_at) || !resendExpired)) {
      console.log(
        linkActive(row.expires_at)
          ? `PENDING    ${unitLabel(t)}  ${t.name} (link still valid)`
          : `EXPIRED    ${unitLabel(t)}  ${t.name} (add --resend-expired to re-send)`,
      );
      skipped++;
      continue;
    }
    const { url } = await issueLink(row.id);
    const res = await sendEmergencyContactRequest(
      t.email,
      { firstName: firstName(t.name), unitLabel: unitLabel(t), url },
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
