/**
 * Utility statement intake for the external statements agent —
 * `POST /api/utilities/statements`.
 *
 * The agent downloads PSE&G / ConEd statements and has already read them, so
 * it sends the PDF together with the fields it extracted. We verify those
 * fields against the PDF's own text layer with plain code (no model call) and
 * store the bill through the same `ingestBill` path as a portal upload. Only
 * when a check fails (scanned PDF, photo, numbers not printed on the bill,
 * charges not adding up) does Claude read the statement instead.
 *
 * Auth: static bearer token `UTILITIES_API_KEY` — separate from the other API
 * keys so the agent's token can't read tenant PII or inventory. Writes go
 * through the service role. Never charges tenants: overage posting stays a
 * manual operator action on /utilities.
 *
 * Docs: /developers (Utilities tab) — keep in sync when this changes.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requireBearer } from "@/lib/api-auth";
import { extractUtilityBill, type ExtractedBill } from "@/lib/utility-extract";
import { findHashDuplicate, ingestBill, loadUnits } from "@/lib/utility-ingest";
import {
  AgentBillSchema,
  matchUnitByAddress,
  pdfText,
  verifyAgentBill,
} from "@/lib/utility-verify";

export const dynamic = "force-dynamic";
// The Claude fallback reads the whole statement.
export const maxDuration = 300;

const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const AGENT_NOTE = "Submitted by the statements agent via API.";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const fail = (status: number, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...extra }, { status });

const withNote = (notes: string | null, line: string) =>
  notes ? `${notes}\n${line}` : line;

export async function POST(req: Request) {
  const denied = requireBearer(req, "UTILITIES_API_KEY");
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "Body must be multipart/form-data with 'statement' and 'data' parts.");
  }

  const file = form.get("statement");
  if (!(file instanceof File) || file.size === 0)
    return fail(400, "Missing 'statement' file part.");
  if (file.size > MAX_STATEMENT_BYTES)
    return fail(400, "Statement must be 20 MB or smaller.");
  const mediaType = file.type || "application/pdf";
  if (!MEDIA_TYPES.has(mediaType))
    return fail(400, "Statement must be a PDF or a PNG/JPEG/WebP image.");

  const rawData = form.get("data");
  if (typeof rawData !== "string")
    return fail(400, "Missing 'data' part (JSON string).");
  let json: unknown;
  try {
    json = JSON.parse(rawData);
  } catch {
    return fail(400, "'data' is not valid JSON.");
  }
  const parsed = AgentBillSchema.safeParse(json);
  if (!parsed.success)
    return fail(400, "'data' does not match the schema.", {
      issues: parsed.error.issues,
    });
  const bill = parsed.data;
  // Same deterministic backstop as the Claude path: security-deposit
  // movements are never service charges.
  bill.charges = bill.charges.filter((c) => !/deposit/i.test(c.description));

  const sb = admin();
  let units;
  try {
    units = await loadUnits(sb);
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : "Failed to load units.");
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buf).digest("hex");
  const hashDup = await findHashDuplicate(sb, fileHash);
  if (hashDup) return fail(409, hashDup);

  const text = mediaType === "application/pdf" ? await pdfText(buf) : null;
  const failures = verifyAgentBill(bill, text);

  let extracted: ExtractedBill;
  let source: "agent" | "claude_fallback";
  if (failures.length === 0) {
    extracted = {
      provider: bill.provider,
      utility_type: bill.utility_type,
      account_number: bill.account_number,
      service_address: bill.service_address,
      statement_date: bill.statement_date,
      period_start: bill.period_start,
      period_end: bill.period_end,
      charges: bill.charges,
      property_id: matchUnitByAddress(bill.service_address, units),
      notes: withNote(bill.notes, AGENT_NOTE),
    };
    source = "agent";
  } else {
    console.info(
      `[utilities-api] agent data failed ${failures.length} check(s), falling back to Claude:`,
      failures,
    );
    try {
      extracted = await extractUtilityBill(
        { base64: buf.toString("base64"), mediaType },
        units,
      );
    } catch (e) {
      return fail(
        422,
        `Agent data failed checks and Claude could not read the statement: ${e instanceof Error ? e.message : "unknown error"}`,
        { failed_checks: failures },
      );
    }
    extracted.notes = withNote(
      extracted.notes,
      `${AGENT_NOTE} Read by Claude because the agent's data failed: ${failures.join("; ")}.`,
    );
    source = "claude_fallback";
  }

  const res = await ingestBill(sb, {
    buf,
    fileName: file.name,
    mediaType,
    fileHash,
    extracted,
    units,
  });
  if (!res.ok)
    return fail(res.duplicate ? 409 : 422, res.error, {
      source,
      failed_checks: failures,
    });

  revalidatePath("/utilities");
  const warnings = [...failures];
  if (!res.extracted.property_id)
    warnings.push("No unit matched the service address — assign it on /utilities.");
  return NextResponse.json(
    {
      bill_id: res.billId,
      total: res.total,
      unit: res.unit?.label ?? null,
      source,
      warnings,
    },
    { status: 201 },
  );
}
