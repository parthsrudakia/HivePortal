import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { todayISO } from "@/lib/date";
import { sendAgreementRequest } from "@/lib/agreement-send";
import {
  admin,
  normalizeMoney,
  parseIsoDate,
  SINGLE_EMAIL_RE,
} from "./helpers";

// Generate a sublease agreement PDF and send it from the right mailbox. New York
// → no letterhead, sent from personal Gmail (From "Vineet", unbranded). Otherwise
// → with letterhead, sent from the M365 (Outlook) work account. Sends straight
// to the tenant — no draft step.
export async function sendAgreement(args: {
  tenant_name: string;
  recipient_email: string;
  property_address: string;
  rent: string;
  security_deposit: string;
  lease_start_date: string;
  lease_end_date: string;
  in_new_york: boolean;
  sublessor_name?: string;
  pro_rate_rent?: string;
  agreement_date?: string;
  confirm_mailbox_mismatch?: boolean;
  property_id?: string;
}) {
  // Validate everything up front: a lease PDF with a malformed date or amount,
  // or sent to a mistyped address, is worse than an error the operator can fix.
  const recipient = args.recipient_email.trim();
  if (!SINGLE_EMAIL_RE.test(recipient)) {
    return {
      ok: false,
      error: `"${args.recipient_email}" is not a valid single email address — double-check it with the operator.`,
    };
  }
  const rent = normalizeMoney(args.rent);
  if (!rent) {
    return { ok: false, error: `Rent "${args.rent}" is not a valid amount.` };
  }
  const deposit = normalizeMoney(args.security_deposit);
  if (!deposit) {
    return {
      ok: false,
      error: `Security deposit "${args.security_deposit}" is not a valid amount.`,
    };
  }
  const proRate = args.pro_rate_rent?.trim()
    ? normalizeMoney(args.pro_rate_rent)
    : undefined;
  if (args.pro_rate_rent?.trim() && !proRate) {
    return {
      ok: false,
      error: `Prorated rent "${args.pro_rate_rent}" is not a valid amount.`,
    };
  }
  const start = parseIsoDate(args.lease_start_date);
  const end = parseIsoDate(args.lease_end_date);
  if (!start || !end) {
    return {
      ok: false,
      error: 'Lease dates must be real dates in "YYYY-MM-DD" format.',
    };
  }
  if (end <= start) {
    return {
      ok: false,
      error: `Lease end (${args.lease_end_date}) must be after lease start (${args.lease_start_date}).`,
    };
  }
  if (args.agreement_date && !parseIsoDate(args.agreement_date)) {
    return {
      ok: false,
      error: 'agreement_date must be a real date in "YYYY-MM-DD" format.',
    };
  }
  // in_new_york picks the mailbox, branding, and letterhead. If the address
  // ends in a two-letter state that contradicts the flag, stop and ask rather
  // than silently send a mis-branded agreement from the wrong account. The
  // operator's word wins: a retry with confirm_mailbox_mismatch=true (set only
  // after they explicitly insist) sends exactly as instructed.
  const stateMatch = args.property_address.match(
    /,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*$/,
  );
  const state = stateMatch?.[1]?.toUpperCase();
  if (
    state &&
    (state === "NY") !== args.in_new_york &&
    !args.confirm_mailbox_mismatch
  ) {
    return {
      ok: false,
      error:
        `The address ends in "${state}" but in_new_york=${args.in_new_york} — ` +
        "that combination would send from the " +
        (args.in_new_york
          ? "personal Gmail without letterhead"
          : "Outlook work account with letterhead") +
        ". Double-check with the operator; if they confirm this is intended, " +
        "call send_agreement again with confirm_mailbox_mismatch=true.",
    };
  }

  // Shared send path: stamps the operator's signature on the PDF, stores it,
  // records the signing request (the /agreements tally), and emails the
  // attachment plus a 48-hour signing link. Also writes the email_log row.
  const mailbox = args.in_new_york ? "gmail" : "outlook";
  const result = await sendAgreementRequest({
    tenantName: args.tenant_name,
    sublessorName: args.sublessor_name?.trim() || "Vineet Dutta",
    propertyAddress: args.property_address,
    rent,
    securityDeposit: deposit,
    leaseStartDate: args.lease_start_date,
    leaseEndDate: args.lease_end_date,
    agreementDate: args.agreement_date || todayISO(),
    proRateRent: proRate ?? undefined,
    recipientEmail: recipient,
    inNewYork: args.in_new_york,
    propertyId: args.property_id,
  });

  if (!result.ok) {
    return { ok: false, mailbox, error: result.error, diag: result.diag };
  }

  // The operator confirmed this exact address and it went out on a real
  // agreement — remember it so future agreements for this property reuse it
  // verbatim. Best-effort: a save failure must not taint the send report.
  if (args.property_id) {
    await admin()
      .from("agreement_addresses")
      .upsert(
        {
          property_id: args.property_id,
          full_address: args.property_address.trim(),
          confirmed_at: new Date().toISOString(),
        },
        { onConflict: "property_id" },
      );
  }

  return {
    ok: true,
    mailbox,
    letterhead: !args.in_new_york,
    sent: true,
    recipient,
    signing_link_expires: "48h",
    signing_tally: "The tenant now appears in the /agreements signing tally until they sign online.",
    diag: result.diag,
  };
}

// Short-lived signed download link for the lease PDF on file.
export async function getLeaseUrl(args: { tenancy_id: string }) {
  const supabase = admin();
  const { data: tenancy, error } = await supabase
    .from("tenancies")
    .select("lease_pdf_path")
    .eq("id", args.tenancy_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!tenancy?.lease_pdf_path)
    throw new Error("No lease PDF on file for this tenancy.");

  const { data, error: signErr } = await supabase.storage
    .from("leases")
    .createSignedUrl(tenancy.lease_pdf_path, 600);
  if (signErr) throw new Error(signErr.message);
  return { url: data.signedUrl, expires_in_minutes: 10 };
}

export const agreementsTools = [
  betaZodTool({
    name: "send_agreement",
    description:
      "Generate a sublease agreement PDF (pre-signed by the operator) and SEND it " +
      "straight to the tenant, along with a 48-hour online signing link. New " +
      "York apartments → no letterhead, sent from the personal Gmail account (From " +
      "\"Vineet\", unbranded). Non-New-York → with letterhead, sent from the " +
      "Outlook/M365 work account. The tenant then appears in the /agreements " +
      "signing tally until they sign online (a signed copy is emailed to them " +
      "automatically). Requires the operator's signature to be on file — if the " +
      "send fails with a missing-signature error, tell the operator to draw it on " +
      "the portal's Agreements page. This sends immediately — there is no draft to " +
      "review. Only call this once you have all required fields and the operator " +
      "has confirmed; ask for anything missing first.",
    inputSchema: z.object({
      tenant_name: z.string().describe("Tenant's full name"),
      recipient_email: z.string().describe("Tenant email address to send the agreement to"),
      property_address: z
        .string()
        .describe("Full property address (include city/state for non-NY units)"),
      rent: z.string().describe('Monthly rent, e.g. "1650"'),
      security_deposit: z.string().describe("Security deposit amount"),
      lease_start_date: z.string().describe('Lease start "YYYY-MM-DD"'),
      lease_end_date: z.string().describe('Lease end "YYYY-MM-DD"'),
      in_new_york: z
        .boolean()
        .describe(
          "True if the apartment is in New York (→ no letterhead, Gmail). " +
            "False otherwise (→ letterhead, Outlook).",
        ),
      sublessor_name: z
        .string()
        .optional()
        .describe('Sublessor name; defaults to "Vineet Dutta"'),
      pro_rate_rent: z
        .string()
        .optional()
        .describe("Prorated first-month rent, if any"),
      agreement_date: z
        .string()
        .optional()
        .describe('Agreement date "YYYY-MM-DD"; defaults to today'),
      confirm_mailbox_mismatch: z
        .boolean()
        .optional()
        .describe(
          "Set true ONLY after the operator explicitly insists on sending even " +
            "though the property address's state contradicts in_new_york. " +
            "Never set it on the first attempt.",
        ),
      property_id: z
        .string()
        .optional()
        .describe(
          "UUID from resolve_property_address. Always pass it when known: on " +
            "a successful send the confirmed property_address is saved and " +
            "reused verbatim for future agreements at this property.",
        ),
    }),
    run: async (args) => JSON.stringify(await sendAgreement(args)),
  }),
  betaZodTool({
    name: "get_lease_url",
    description:
      "Get a download link for the lease PDF on file for a tenancy. The link " +
      "is signed and expires after 10 minutes.",
    inputSchema: z.object({ tenancy_id: z.string() }),
    run: async (args) => JSON.stringify(await getLeaseUrl(args)),
  }),
];
