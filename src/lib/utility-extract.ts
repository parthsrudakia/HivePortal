/**
 * Utility statement extraction — Claude reads an uploaded statement (PDF or
 * photo) and returns structured bill data: provider, utility type, service
 * period, which of our units it belongs to, and the current cycle's charges.
 *
 * Rules enforced in the prompt and schema:
 *  - Previous balance / payments received / amount carried forward are
 *    IGNORED — only charges billed for the current cycle are extracted.
 *  - Late fees and any other non-usage charges come back as separate line
 *    items (kind 'late_fee' / 'other') so they can be tracked individually.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export type UnitOption = {
  id: string;
  label: string; // "Building/Street Apt X"
  street_address: string;
  unit_number: string;
};

const ChargeSchema = z.object({
  kind: z
    .enum(["current", "late_fee", "other"])
    .describe(
      "current = this cycle's usage/service charges (incl. taxes & supply/delivery). " +
        "late_fee = late payment fees. other = any other one-off charge (deposits, " +
        "connection fees, equipment).",
    ),
  description: z.string().describe("Short label as printed on the statement"),
  amount: z.number().describe("Dollar amount of this charge"),
});

const ExtractionSchema = z.object({
  provider: z.string().nullable().describe("Company issuing the bill, e.g. PSE&G, Con Edison"),
  utility_type: z
    .enum(["electric", "gas", "water", "internet", "trash", "other"])
    .describe(
      "electric = any bill with electricity charges, INCLUDING combined " +
        "electric+gas statements (e.g. PSE&G). gas = gas-only bills. Never " +
        "use 'other' for a bill that has electric or gas charges.",
    ),
  account_number: z.string().nullable(),
  service_address: z.string().nullable().describe("Service address as printed"),
  statement_date: z.string().nullable().describe('"YYYY-MM-DD"'),
  period_start: z.string().nullable().describe('Billing period start, "YYYY-MM-DD"'),
  period_end: z.string().nullable().describe('Billing period end, "YYYY-MM-DD"'),
  property_id: z
    .string()
    .nullable()
    .describe(
      "The id of the matching unit from the provided list (match on the service " +
        "address, including the apartment/unit number). null if no unit matches.",
    ),
  charges: z
    .array(ChargeSchema)
    .describe(
      "Every charge billed FOR THIS CYCLE ONLY — service that falls within " +
        "this statement's own billing period. NEVER include previous balance, " +
        "balance forward, payments received, or credits from earlier bills. " +
        "NEVER include lines that itemize an EARLIER billing period's usage " +
        "(re-billed or adjusted prior cycles, 'service from <older period>' " +
        "blocks) — those belong to that period's own statement.",
    ),
  notes: z
    .string()
    .nullable()
    .describe("Anything ambiguous or unusual the operator should double-check"),
});

export type ExtractedBill = z.infer<typeof ExtractionSchema>;

const MEDIA_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export async function extractUtilityBill(
  file: { base64: string; mediaType: string },
  units: UnitOption[],
): Promise<ExtractedBill> {
  if (!MEDIA_TYPES.has(file.mediaType)) {
    throw new Error("Statement must be a PDF or a PNG/JPEG/WebP photo.");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const unitList = units
    .map((u) => `${u.id} | ${u.label} | ${u.street_address} Apt ${u.unit_number}`)
    .join("\n");

  const doc =
    file.mediaType === "application/pdf"
      ? ({
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: file.base64,
          },
        } as const)
      : ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: file.mediaType as "image/png" | "image/jpeg" | "image/webp",
            data: file.base64,
          },
        } as const);

  const response = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          doc,
          {
            type: "text",
            text:
              "Extract this utility statement into the schema.\n\n" +
              "Our units (id | label | address):\n" +
              unitList +
              "\n\nRules:\n" +
              "- charges = ONLY what is billed for this cycle. Ignore previous " +
              "balance, balance forward, payments received, and credits from " +
              "prior bills entirely — do not list them as charges.\n" +
              "- If the statement also itemizes charges for an EARLIER billing " +
              "period (a re-billed estimated cycle, a prior-period adjustment, " +
              "a 'service from <older dates>' section), EXCLUDE those lines too " +
              "— each cycle is captured from its own statement, so re-listing " +
              "an old cycle here would double-count it. Mention any such " +
              "excluded prior-period section in notes.\n" +
              "- Late fees and other one-off charges are separate line items " +
              "with kind 'late_fee' / 'other'; regular usage, supply, delivery, " +
              "service and tax lines are kind 'current' (consolidate small tax/" +
              "surcharge lines into the related current charge when itemizing " +
              "them adds no information).\n" +
              "- property_id: match the service address against the unit list, " +
              "paying attention to the apartment number. If unsure, null.\n" +
              "- Dates in YYYY-MM-DD.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("Could not extract structured data from the statement.");
  }
  return response.parsed_output;
}
