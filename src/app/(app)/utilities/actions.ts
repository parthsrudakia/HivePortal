"use server";

import { revalidatePath } from "next/cache";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { extractUtilityBill, type UnitOption } from "@/lib/utility-extract";

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

  // Extract first — if Claude can't read it, don't leave an orphaned upload.
  const buf = Buffer.from(await file.arrayBuffer());
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

  if (extracted.charges.length === 0) {
    return {
      error:
        "No current-cycle charges found on that statement (previous-balance " +
        "amounts are ignored by design). Check the file and try again.",
    };
  }

  // Store the original statement.
  const safeName = file.name.replace(/[^\w.\-]/g, "_") || "statement";
  const path = `${extracted.property_id ?? "unmatched"}/${Date.now()}-${safeName}`;
  const { error: upErr } = await sb.storage
    .from("utilities")
    .upload(path, buf, { contentType: mediaType, upsert: false });
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
      due_date: extracted.due_date,
      total_amount: total,
      statement_path: path,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin() as any)
    .from("utility_bills")
    .update({ property_id: propertyId })
    .eq("id", billId);
  if (error) return { error: error.message };
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
