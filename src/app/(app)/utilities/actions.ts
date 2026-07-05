"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { extractUtilityBill, type UnitOption } from "@/lib/utility-extract";
import { compressStatement } from "@/lib/compress-statement";

export type UploadState =
  | { error?: string; success?: string; warning?: string }
  | undefined;

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;

// Normalized hint keys for the learned statement→unit mappings.
function hintKeys(bill: {
  account_number: string | null;
  service_address: string | null;
}): string[] {
  const keys: string[] = [];
  const acct = bill.account_number?.replace(/\D/g, "");
  if (acct) keys.push(`acct:${acct}`);
  const addr = bill.service_address?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (addr) keys.push(`addr:${addr}`);
  return keys;
}

export async function uploadStatement(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const file = formData.get("statement");
  if (!(file instanceof File) || file.size === 0)
    return { error: "Drop a statement file first." };
  if (file.size > MAX_STATEMENT_BYTES)
    return { error: "Statement must be 20 MB or smaller." };
  const mediaType = file.type || "application/pdf";

  const sb = admin();

  // Units for address matching.
  const { data: props } = await sb
    .from("properties")
    .select("id, building_name, street_address, unit_number");
  const units: UnitOption[] = (props ?? []).map((p) => ({
    id: p.id,
    label: `${p.building_name?.trim() || p.street_address} Apt ${p.unit_number}`,
    street_address: p.street_address,
    unit_number: p.unit_number,
  }));

  const buf = Buffer.from(await file.arrayBuffer());

  // Duplicate guard 1: the exact same file was uploaded before. Checked
  // before extraction so a re-drop doesn't burn an extraction call.
  const fileHash = createHash("sha256").update(buf).digest("hex");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dup } = await (sb as any)
      .from("utility_bills")
      .select("id, provider, statement_date")
      .eq("file_sha256", fileHash)
      .maybeSingle();
    if (dup) {
      const what = [dup.provider, dup.statement_date && `statement ${dup.statement_date}`]
        .filter(Boolean)
        .join(", ");
      return {
        error: `Duplicate — this exact file is already in the log${what ? ` (${what})` : ""}. Discarded.`,
      };
    }
  }

  // Extract — if Claude can't read it, don't leave an orphaned upload.
  let extracted;
  try {
    extracted = await extractUtilityBill(
      { base64: buf.toString("base64"), mediaType },
      units,
    );
  } catch (e) {
    return {
      error: `Could not read the statement: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }

  // Operator-confirmed mappings beat the model's guess: if this account or
  // service address was ever manually assigned to a unit, reuse that unit.
  const keys = hintKeys(extracted);
  let learned = false;
  if (keys.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: hints } = await (sb as any)
      .from("utility_unit_hints")
      .select("key, property_id")
      .in("key", keys);
    const hint = (hints ?? [])[0];
    if (hint && hint.property_id !== extracted.property_id) {
      extracted.property_id = hint.property_id;
      learned = true;
    }
  }

  if (extracted.charges.length === 0) {
    return {
      error:
        "No current-cycle charges found on that statement (previous-balance " +
        "amounts are ignored by design). Check the file and try again.",
    };
  }

  // Duplicate guard 2: the same bill re-scanned or exported again (different
  // bytes, same account + billing period / statement date).
  {
    const acct = extracted.account_number?.replace(/\D/g, "") || null;
    if (acct && (extracted.period_start || extracted.statement_date)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (sb as any)
        .from("utility_bills")
        .select("id, account_number, provider");
      if (extracted.period_start && extracted.period_end) {
        q = q
          .eq("period_start", extracted.period_start)
          .eq("period_end", extracted.period_end);
      } else {
        q = q.eq("statement_date", extracted.statement_date);
      }
      const { data: candidates } = await q;
      const dup = (candidates ?? []).find(
        (c: { account_number: string | null }) =>
          (c.account_number ?? "").replace(/\D/g, "") === acct,
      );
      if (dup) {
        return {
          error:
            `Duplicate — a bill for this account and period is already in the log` +
            `${dup.provider ? ` (${dup.provider})` : ""}. Discarded.`,
        };
      }
    }
  }

  // Store the statement, compressed as far as it will go (extraction above
  // already ran on the original bytes; the hash also covers the original).
  const compressed = await compressStatement(buf, mediaType);
  let safeName = file.name.replace(/[^\w.\-]/g, "_") || "statement";
  if (compressed.mediaType === "image/webp" && !/\.webp$/i.test(safeName)) {
    safeName = safeName.replace(/\.[a-z0-9]+$/i, "") + ".webp";
  }
  const path = `${extracted.property_id ?? "unmatched"}/${Date.now()}-${safeName}`;
  const { error: upErr } = await sb.storage
    .from("utilities")
    .upload(path, compressed.data, {
      contentType: compressed.mediaType,
      upsert: false,
    });
  if (upErr) return { error: `Failed to store the statement: ${upErr.message}` };

  const total = extracted.charges.reduce((s, c) => s + c.amount, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error: insErr } = await (sb as any)
    .from("utility_bills")
    .insert({
      property_id: extracted.property_id,
      provider: extracted.provider,
      utility_type: extracted.utility_type,
      account_number: extracted.account_number,
      service_address: extracted.service_address,
      statement_date: extracted.statement_date,
      period_start: extracted.period_start,
      period_end: extracted.period_end,
      total_amount: total,
      statement_path: path,
      file_sha256: fileHash,
      notes: extracted.notes,
    })
    .select("id")
    .single();
  if (insErr) {
    await sb.storage.from("utilities").remove([path]);
    return { error: insErr.message };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: chErr } = await (sb as any).from("utility_bill_charges").insert(
    extracted.charges.map((c) => ({
      bill_id: bill.id,
      kind: c.kind,
      description: c.description,
      amount: c.amount,
    })),
  );
  if (chErr) return { error: chErr.message };

  revalidatePath("/utilities");
  const unit = units.find((u) => u.id === extracted.property_id);
  const extras = extracted.charges.filter((c) => c.kind !== "current");
  const parts = [
    `Logged $${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    extracted.provider ?? "utility",
    unit ? `for ${unit.label}` : "",
    learned ? "(matched from your earlier manual assignment)" : "",
    extras.length
      ? `(${extras.length} late-fee/other charge${extras.length === 1 ? "" : "s"} saved separately)`
      : "",
  ].filter(Boolean);
  return {
    success: parts.join(" "),
    warning: !extracted.property_id
      ? "Couldn't match the service address to a unit — assign it in the log below."
      : undefined,
  };
}

export async function assignBillProperty(
  billId: string,
  propertyId: string | null,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const sb = admin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error } = await (sb as any)
    .from("utility_bills")
    .update({ property_id: propertyId })
    .eq("id", billId)
    .select("account_number, service_address")
    .single();
  if (error) return { error: error.message };

  // Learn from the correction: remember this account/address → unit so the
  // next statement from the same source is assigned automatically.
  const keys = bill ? hintKeys(bill) : [];
  if (keys.length > 0) {
    if (propertyId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any).from("utility_unit_hints").upsert(
        keys.map((key) => ({ key, property_id: propertyId })),
        { onConflict: "key" },
      );
    } else {
      // Un-assigning means the learned mapping was wrong — forget it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any).from("utility_unit_hints").delete().in("key", keys);
    }
  }
  revalidatePath("/utilities");
  return { success: "Bill reassigned." };
}

export async function deleteBill(billId: string): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const sb = admin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill } = await (sb as any)
    .from("utility_bills")
    .select("statement_path")
    .eq("id", billId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (sb as any).from("utility_bills").delete().eq("id", billId);
  if (error) return { error: error.message };
  if (bill?.statement_path) {
    await sb.storage.from("utilities").remove([bill.statement_path]);
  }
  revalidatePath("/utilities");
  return { success: "Bill deleted." };
}

// Dismiss (or restore) a bill's over-$200 flag in the banner. The badge on
// the bill card itself is not affected.
export async function dismissOverage(
  billIds: string[],
  dismissed: boolean,
): Promise<UploadState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (billIds.length === 0) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin() as any)
    .from("utility_bills")
    .update({ overage_dismissed: dismissed })
    .in("id", billIds);
  if (error) return { error: error.message };
  revalidatePath("/utilities");
  return undefined;
}

export async function getStatementUrl(
  billId: string,
): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const sb = admin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bill, error } = await (sb as any)
    .from("utility_bills")
    .select("statement_path")
    .eq("id", billId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!bill?.statement_path) return { error: "No statement on file." };
  const { data, error: signErr } = await sb.storage
    .from("utilities")
    .createSignedUrl(bill.statement_path, 300);
  if (signErr) return { error: signErr.message };
  return { url: data.signedUrl };
}
