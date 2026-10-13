/**
 * Model-free checks for utility-bill data supplied by an external agent
 * (`POST /api/utilities/statements`). The agent has already read the
 * statement; instead of paying Claude to read it again, we pull the PDF's
 * text layer and confirm the agent's numbers are actually printed on it and
 * add up. Any failure sends the statement to the Claude extraction fallback.
 */

import { z } from "zod";
import { extractText } from "unpdf";
import { todayISO } from "@/lib/date";
import { ExtractionSchema, type UnitOption } from "@/lib/utility-extract";
import { STATEMENT_SOURCES } from "@/lib/utility-ingest";

/** What the agent sends: the extraction schema minus the unit match (the
 *  portal matches units itself), plus the printed total to check against. */
export const AgentBillSchema = ExtractionSchema.omit({ property_id: true })
  .extend({
    source: z
      .enum(STATEMENT_SOURCES)
      .describe("Where the statement was downloaded from: pseg, coned, or other."),
    printed_total: z
      .number()
      .describe(
        "This cycle's new-charges total exactly as printed on the statement " +
          "(not the amount due — excludes previous balance and payments).",
      ),
  })
  .strict();

export type AgentBill = z.infer<typeof AgentBillSchema>;

/** The PDF's text layer, whitespace-collapsed; null when there is none
 *  (scanned image PDF) or the file can't be parsed. */
export async function pdfText(buf: Buffer): Promise<string | null> {
  try {
    const { text } = await extractText(new Uint8Array(buf), {
      mergePages: true,
    });
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length >= 50 ? flat : null;
  } catch {
    return null;
  }
}

const cents = (n: number) => Math.round(n * 100);

function amountPrinted(text: string, amount: number): boolean {
  const abs = Math.abs(amount);
  const plain = abs.toFixed(2);
  const grouped = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Bounded so "12.34" doesn't match inside "112.34".
  return [plain, grouped].some((s) =>
    new RegExp(`(^|[^\\d,.])${s.replace(/[.,]/g, "\\$&")}(?!\\d)`).test(text),
  );
}

const isDate = (s: string | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const dayDiff = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** Returns the failed checks; empty means the agent's data can be stored
 *  as-is. `text` is the statement's text layer (null = none). */
export function verifyAgentBill(bill: AgentBill, text: string | null): string[] {
  const failures: string[] = [];

  if (bill.charges.length === 0) failures.push("no charges supplied");
  for (const c of bill.charges) {
    if (!(c.amount > 0) || c.amount >= 5000)
      failures.push(`charge "${c.description}" amount ${c.amount} out of range`);
  }

  // Arithmetic: the line items must add up to the printed total. Statements
  // differ on whether late fees sit inside "current charges", so accept a
  // match against either all lines or the current-usage lines only.
  const all = bill.charges.reduce((s, c) => s + cents(c.amount), 0);
  const current = bill.charges
    .filter((c) => c.kind === "current")
    .reduce((s, c) => s + cents(c.amount), 0);
  const printed = cents(bill.printed_total);
  if (Math.abs(all - printed) > 1 && Math.abs(current - printed) > 1) {
    failures.push(
      `charges sum to ${(all / 100).toFixed(2)} but printed_total is ${bill.printed_total.toFixed(2)}`,
    );
  }

  // Dates.
  if (!isDate(bill.period_start) || !isDate(bill.period_end)) {
    failures.push("billing period missing or not YYYY-MM-DD");
  } else {
    const days = dayDiff(bill.period_start, bill.period_end);
    if (days < 20 || days > 40)
      failures.push(`billing period is ${days} days (expected 20–40)`);
  }
  if (bill.statement_date !== null) {
    if (!isDate(bill.statement_date))
      failures.push("statement_date not YYYY-MM-DD");
    else if (dayDiff(todayISO(), bill.statement_date) > 7)
      failures.push("statement_date is in the future");
  }

  // Grounding: everything we store must be printed on the statement.
  if (text === null) {
    failures.push("statement has no text layer to check against");
    return failures;
  }
  const acct = bill.account_number?.replace(/\D/g, "") ?? "";
  if (acct.length < 6) {
    failures.push("account number missing");
  } else if (!text.replace(/\D/g, "").includes(acct)) {
    failures.push("account number not found on the statement");
  }
  if (!amountPrinted(text, bill.printed_total))
    failures.push(`printed_total ${bill.printed_total.toFixed(2)} not found on the statement`);
  for (const c of bill.charges) {
    if (!amountPrinted(text, c.amount))
      failures.push(`charge "${c.description}" ${c.amount.toFixed(2)} not found on the statement`);
  }

  return failures;
}

const SUFFIXES: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", boulevard: "blvd",
  place: "pl", drive: "dr", lane: "ln", court: "ct", terrace: "ter",
  parkway: "pkwy", highway: "hwy", north: "n", south: "s", east: "e",
  west: "w",
};

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/#/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((t) => SUFFIXES[t] ?? t);

const unitToken = (u: string) =>
  u.toLowerCase().replace(/^(apt|unit|suite|ste|fl|floor)\s*/i, "").replace(/[^a-z0-9]/g, "");

/**
 * Deterministic service-address → unit match: the unit's street tokens must
 * appear in order in the address, and the unit number must appear after
 * them. Returns an id only when exactly one unit matches.
 */
export function matchUnitByAddress(
  address: string | null,
  units: UnitOption[],
): string | null {
  if (!address) return null;
  const addr = tokens(address);
  const hits = units.filter((u) => {
    const street = tokens(u.street_address);
    if (street.length === 0) return false;
    let at = -1;
    for (let i = 0; i + street.length <= addr.length; i++) {
      if (street.every((t, j) => addr[i + j] === t)) {
        at = i + street.length;
        break;
      }
    }
    if (at < 0) return false;
    const unit = unitToken(u.unit_number);
    return !!unit && addr.slice(at).includes(unit);
  });
  return hits.length === 1 ? hits[0].id : null;
}
