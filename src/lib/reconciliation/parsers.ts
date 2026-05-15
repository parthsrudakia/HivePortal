/**
 * Reconciliation file parsers.
 *
 * Both inputs (bank statement, other-payments) flow through the same
 * pipeline: extract a list of {date, description, amount} rows, normalise
 * the description into a match key, drop non-positive amounts. Header row
 * is auto-detected by looking for a row that contains both "Description"
 * and "Amount" columns (or close variants), so we don't break the moment
 * a bank changes its export preamble length.
 */

import Papa from "papaparse";
import ExcelJS from "exceljs";

export type Deposit = {
  description: string; // lowercased match key
  raw: string;         // original description (for display / debugging)
  amount: number;
  date: string | null; // YYYY-MM-DD when known
  source: "bank" | "other";
};

const ZELLE_PREFIX_PAID = /^Zelle payment from /i;
const ZELLE_PREFIX_SCHED = /^Zelle Scheduled payment from /i;
const FOR_SUFFIX = / for [^,]*$/i;
const CONF_SUFFIX = / Conf# .*$/i;
const REF_SUFFIX = / Ref# .*$/i;

function moneyToNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;
  // MM/DD/YYYY or MM/DD/YY
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) {
    let [, mm, dd, yy] = m;
    let year = parseInt(yy, 10);
    if (year < 100) year += 2000;
    return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** Strip Zelle-style prefixes and trailing junk so a Zelle deposit collapses
 *  to the payer's name. Generic enough that non-Zelle rows pass through with
 *  just normalisation. */
function cleanDescription(raw: string): string {
  let s = raw.trim();
  s = s.replace(ZELLE_PREFIX_SCHED, "");
  s = s.replace(ZELLE_PREFIX_PAID, "");
  s = s.replace(FOR_SUFFIX, "");
  s = s.replace(CONF_SUFFIX, "");
  s = s.replace(REF_SUFFIX, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// CSV / XLSX → rows[]
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

async function readCsvToMatrix(text: string): Promise<string[][]> {
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: true,
  });
  return (parsed.data as string[][]).filter((r) => Array.isArray(r));
}

async function readXlsxToMatrix(buffer: ArrayBuffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = row.values as (ExcelJS.CellValue | undefined)[];
    // ExcelJS rows are 1-indexed (cells[0] unused).
    const values = cells.slice(1).map((c) => {
      if (c === null || c === undefined) return "";
      if (c instanceof Date) return c.toISOString().slice(0, 10);
      if (typeof c === "object" && c !== null) {
        if ("text" in c) return String((c as { text: unknown }).text ?? "");
        if ("result" in c) return String((c as { result: unknown }).result ?? "");
        if ("richText" in c) {
          return (c as { richText: { text: string }[] }).richText
            .map((p) => p.text)
            .join("");
        }
      }
      return String(c);
    });
    matrix.push(values);
  });
  return matrix;
}

/** Find the header row by looking for a row containing both an
 *  amount-ish and description-ish column. Returns -1 if not found. */
function findHeaderRowIdx(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => String(c ?? "").trim().toLowerCase());
    const hasAmount = cells.some((c) => /^(amount|total|debit|credit|deposit)$/.test(c));
    const hasDesc = cells.some(
      (c) => /^(description|payee|memo|details?|narration|payer)$/.test(c),
    );
    if (hasAmount && hasDesc) return i;
  }
  return -1;
}

function indexOfMatching(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (re.test(headers[i])) return i;
    }
  }
  return -1;
}

function matrixToRows(rows: string[][]): Row[] {
  const headerIdx = findHeaderRowIdx(rows);
  if (headerIdx < 0) return [];

  const headers = rows[headerIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const descIdx = indexOfMatching(headers, [
    /^description$/, /^payee$/, /^memo$/, /^details?$/, /^narration$/, /^payer$/,
  ]);
  const amountIdx = indexOfMatching(headers, [
    /^amount$/, /^deposit$/, /^credit$/, /^total$/,
  ]);
  const dateIdx = indexOfMatching(headers, [
    /^date$/, /^posted date$/, /^posting date$/, /^transaction date$/,
  ]);

  if (descIdx < 0 || amountIdx < 0) return [];

  const out: Row[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const row: Row = {
      Description: r[descIdx],
      Amount: r[amountIdx],
      Date: dateIdx >= 0 ? r[dateIdx] : null,
    };
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseResult = {
  deposits: Deposit[];
  /** Lines from the file that were skipped because amount was zero / negative,
   *  or description was blank. Useful for the "we parsed N rows" sanity check. */
  parsedRowCount: number;
};

export async function parseBankFile(file: File): Promise<ParseResult> {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  let matrix: string[][];
  if (isExcel) {
    matrix = await readXlsxToMatrix(await file.arrayBuffer());
  } else {
    const text = await file.text();
    matrix = await readCsvToMatrix(text);
  }
  return rowsToDeposits(matrixToRows(matrix), "bank");
}

export async function parseOtherFile(file: File): Promise<ParseResult> {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  let matrix: string[][];
  if (isExcel) {
    matrix = await readXlsxToMatrix(await file.arrayBuffer());
  } else {
    const text = await file.text();
    matrix = await readCsvToMatrix(text);
  }
  return rowsToDeposits(matrixToRows(matrix), "other");
}

function rowsToDeposits(rows: Row[], source: "bank" | "other"): ParseResult {
  const out: Deposit[] = [];
  for (const r of rows) {
    const raw = String(r["Description"] ?? "").trim();
    if (!raw) continue;
    const amount = moneyToNumber(r["Amount"]);
    if (amount <= 0) continue;
    out.push({
      description: cleanDescription(raw),
      raw,
      amount,
      date: toIsoDate(r["Date"]),
      source,
    });
  }
  return { deposits: out, parsedRowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Sum deposits by their cleaned description (lower-cased match key). */
export function aggregateByDescription(deposits: Deposit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deposits) {
    m.set(d.description, (m.get(d.description) ?? 0) + d.amount);
  }
  return m;
}

/** Deposits whose description didn't appear in `claimedKeys`. */
export function unmatchedDeposits(
  deposits: Deposit[],
  claimedKeys: Set<string>,
): { description: string; raw: string; amount: number; date: string | null }[] {
  // Aggregate per cleaned description so multiple deposits to the same
  // unmatched payer collapse to one line.
  const m = new Map<
    string,
    { raw: string; amount: number; date: string | null }
  >();
  for (const d of deposits) {
    if (claimedKeys.has(d.description)) continue;
    const prev = m.get(d.description);
    if (prev) {
      prev.amount += d.amount;
      if (!prev.date && d.date) prev.date = d.date;
    } else {
      m.set(d.description, { raw: d.raw, amount: d.amount, date: d.date });
    }
  }
  return Array.from(m.entries())
    .map(([description, v]) => ({ description, ...v }))
    .sort((a, b) => b.amount - a.amount);
}
