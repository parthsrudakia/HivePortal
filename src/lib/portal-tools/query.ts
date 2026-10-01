import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { admin } from "./helpers";

// Rows are already capped at 200 in bot_run_query; this caps the SERIALIZED
// size so a handful of very wide rows can't blow the model's context.
const MAX_RESULT_CHARS = 30_000;

export async function queryDatabase(sql: string) {
  const cleaned = sql.trim().replace(/;+\s*$/, "");
  // UX guard only — the real enforcement is Postgres role privileges +
  // read-only transaction in bot_run_query. This just gives a clear message
  // instead of a confusing PG syntax error when the model sends a write.
  if (!/^(select|with)\b/i.test(cleaned)) {
    return {
      ok: false as const,
      error: "Only a single read-only SELECT (or WITH … SELECT) is allowed.",
    };
  }

  const { data, error } = await admin()
    .rpc("bot_run_query", { q: cleaned })
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) {
    return {
      ok: false as const,
      error: error.message,
      hint: error.hint ?? undefined,
    };
  }

  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  let kept = rows;
  let truncated = false;
  // Shed rows off the end until the JSON fits the context budget.
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_RESULT_CHARS) {
    kept = kept.slice(0, -1);
    truncated = true;
  }

  return {
    ok: true as const,
    row_count: rows.length,
    capped_at_200: rows.length === 200,
    truncated,
    rows: kept,
  };
}

export const queryTools = [
  betaZodTool({
    name: "query_database",
    description:
      "Run ONE read-only SQL SELECT against the Hive Portal Postgres database " +
      "and get up to 200 rows back as JSON. Use this for free-form questions " +
      "no purpose-built tool answers: cross-table analytics, custom filters, " +
      "counts, history digs ('who lived in this room before X', 'which tenants " +
      "paid twice in July'). Prefer the dedicated tools for their domains, and " +
      "ALWAYS use the dedicated write tools for actions — this tool physically " +
      "cannot write (the role only has SELECT, and credentials / bot tables are " +
      "invisible). Postgres dialect.\n" +
      "Key tables & joins:\n" +
      "properties(id, building_name, street_address, unit_number, is_new_york)\n" +
      "  ← rooms(property_id, room_number, has_ac, status, total_rent)\n" +
      "  ← tenancies(room_id, tenant_id, status, monthly_rent, start_date, move_out_date, paused_at)\n" +
      "  → tenants(id, full_name, email, phone)\n" +
      "payments(tenancy_id, amount, paid_on, payment_type, method)\n" +
      "tenancy_charges(tenancy_id, bill_id, kind, amount, charged_on)\n" +
      "credit_allocations(tenancy_id, kind, amount); tenancy_rent_history(tenancy_id, effective_month, monthly_rent)\n" +
      "utility_bills(property_id, utility_type, provider, total_amount, period_start, period_end, overage_charged_at)\n" +
      "  ← utility_bill_charges(bill_id, kind, amount); utility_overage_alerts(bill_id, tenancy_id)\n" +
      "cleaning_records(property_id, cleaner_id, cleaned_on); cleaners(id, name)\n" +
      "email_log / sms_log(channel, status, created_at); rent_reminder_batches\n" +
      "reconciliation_deposits(payer_key, amount, payment_id) / _statements / _reversals\n" +
      "agreement_requests(status, tenant_name, recipient_email, property_address, room_number, room_id) — no token column\n" +
      "For any table's full column list, query information_schema.columns " +
      "(it only lists tables you can read).",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "One SELECT or WITH…SELECT statement, no trailing semicolon. " +
            "Results cap at 200 rows — use COUNT/GROUP BY/LIMIT/ORDER BY " +
            "rather than dumping whole tables.",
        ),
    }),
    run: async (args) => JSON.stringify(await queryDatabase(args.sql)),
  }),
];
