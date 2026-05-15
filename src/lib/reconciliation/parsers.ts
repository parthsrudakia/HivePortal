/**
 * Reconciliation file parsers.
 *
 * Match rules (per Vinny):
 *   - Bank file: ONLY rows whose description starts with "Zelle payment from"
 *     (or "Zelle Scheduled payment from") count. Everything else is dropped.
 *   - The payer key is everything after "from" up to (but not including)
 *     " for …" or " Conf# …" suffixes, lowercased — e.g.
 *     "Zelle payment from PATRICK J WALL for May rent" → "patrick j wall".
 *   - Tenant key is `pays_as` (falling back to full_name), lowercased.
 *     So the tenant's pays_as should exactly match how the bank prints
 *     them (e.g. "PATRICK J WALL", not "Patrick Wall").
 *
 * The "other payments" optional file is for manually-recorded payments
 * (Venmo, cash, ClickPay reports). Its Description field IS the payer's
 * name (no Zelle prefix required).
 */

import Papa from "papaparse";
import ExcelJS from "exceljs";

export type Deposit = {
  description: string; // 2-word lowercase match key
  raw: string;         // original raw description (for display / debugging)
  amount: number;
  date: string | null;
  source: "bank" | "other";
};

const ZELLE_FROM_RE = /^Zelle (?:Scheduled )?payment from /i;

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
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) {
    let [, mm, dd, yy] = m;
    let year = parseInt(yy, 10);
    if (year < 100) year += 2000;
    return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** Normalise a name into the match key: collapse whitespace, lowercase. */
function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Extract payer match key from a Zelle deposit description.
 *  Returns null if the row isn't a Zelle deposit. */
function bankPayerKey(raw: string): string | null {
  if (!ZELLE_FROM_RE.test(raw)) return null;
  let s = raw.replace(ZELLE_FROM_RE, "");
  // Stop at the first " for ..." or "Conf#" or "Ref#" or ";" — those follow
  // the payer name in BoA's format.
  s = s.split(/ for /i)[0];
  s = s.split(/Conf#/i)[0];
  s = s.split(/Ref#/i)[0];
  s = s.split(/;/)[0];
  return normalizeName(s);
}

/** Compute the tenant's match key from their pays_as (or full_name). */
export function tenantKey(paysAs: string | null, fullName: string): string {
  const src = (paysAs ?? "").trim() || fullName.trim();
  return normalizeName(src);
}

// ---------------------------------------------------------------------------
// CSV / XLSX → matrix → rows
// ---------------------------------------------------------------------------

async function readCsvToMatrix(text: string): Promise<string[][]> {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
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
    const values = cells.slice(1).map((c) => {
      if (c === null || c === undefined) return "";
      if (c instanceof Date) return c.toISOString().slice(0, 10);
      if (typeof c === "object" && c !== null) {
        if ("text" in c) return String((c as { text: unknown }).text ?? "");
        if ("result" in c) return String((c as { result: unknown }).result ?? "");
        if ("richText" in c)
          return (c as { richText: { text: string }[] }).richText
            .map((p) => p.text)
            .join("");
      }
      return String(c);
    });
    matrix.push(values);
  });
  return matrix;
}

/** Find the row with Description + Amount columns. Bank of America puts a
 *  preamble on top; we don't care how many rows it is — we scan up to 30
 *  rows for the header. */
function findHeaderIdx(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => String(c ?? "").trim().toLowerCase());
    const hasDesc = cells.some(
      (c) => /^(description|payee|memo|details?|narration|payer)$/.test(c),
    );
    const hasAmount = cells.some(
      (c) => /^(amount|deposit|credit|total)$/.test(c),
    );
    if (hasDesc && hasAmount) return i;
  }
  return -1;
}

function colIdx(headers: string[], patterns: RegExp[]): number {
  for (const re of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (re.test(headers[i])) return i;
    }
  }
  return -1;
}

type Row = { description: string; amount: number; date: string | null };

function matrixToRows(matrix: string[][]): {
  rows: Row[];
  parsedRowCount: number;
} {
  const hIdx = findHeaderIdx(matrix);
  if (hIdx < 0) return { rows: [], parsedRowCount: 0 };
  const headers = matrix[hIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const dIdx = colIdx(headers, [
    /^description$/, /^payee$/, /^memo$/, /^details?$/, /^narration$/, /^payer$/,
  ]);
  const aIdx = colIdx(headers, [/^amount$/, /^deposit$/, /^credit$/, /^total$/]);
  const tIdx = colIdx(headers, [
    /^date$/, /^posted date$/, /^posting date$/, /^transaction date$/,
  ]);
  if (dIdx < 0 || aIdx < 0) return { rows: [], parsedRowCount: 0 };

  const rows: Row[] = [];
  for (let i = hIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    rows.push({
      description: String(r[dIdx] ?? "").trim(),
      amount: moneyToNumber(r[aIdx]),
      date: tIdx >= 0 ? toIsoDate(r[tIdx]) : null,
    });
  }
  return { rows, parsedRowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseResult = {
  deposits: Deposit[];
  parsedRowCount: number;
  /** Rows we saw but skipped because they weren't Zelle, were negative,
   *  or had a blank description. For debugging if the result is empty. */
  skipped: { reason: string; count: number }[];
};

async function readFileToMatrix(file: File): Promise<string[][]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    return readXlsxToMatrix(await file.arrayBuffer());
  }
  return readCsvToMatrix(await file.text());
}

export async function parseBankFile(file: File): Promise<ParseResult> {
  const matrix = await readFileToMatrix(file);
  const { rows, parsedRowCount } = matrixToRows(matrix);
  return rowsToDeposits(rows, parsedRowCount, "bank", { zelleOnly: true });
}

export async function parseOtherFile(file: File): Promise<ParseResult> {
  const matrix = await readFileToMatrix(file);
  const { rows, parsedRowCount } = matrixToRows(matrix);
  return rowsToDeposits(rows, parsedRowCount, "other", { zelleOnly: false });
}

function rowsToDeposits(
  rows: Row[],
  parsedRowCount: number,
  source: "bank" | "other",
  opts: { zelleOnly: boolean },
): ParseResult {
  let nonPositive = 0;
  let nonZelle = 0;
  let blank = 0;
  const out: Deposit[] = [];
  for (const r of rows) {
    if (!r.description) {
      blank++;
      continue;
    }
    if (r.amount <= 0) {
      nonPositive++;
      continue;
    }
    let key: string | null;
    if (opts.zelleOnly) {
      key = bankPayerKey(r.description);
      if (key === null) {
        nonZelle++;
        continue;
      }
    } else {
      // Other-payments file: description is the payer name directly.
      key = normalizeName(r.description);
      if (!key) {
        blank++;
        continue;
      }
    }
    out.push({
      description: key,
      raw: r.description,
      amount: r.amount,
      date: r.date,
      source,
    });
  }
  const skipped: { reason: string; count: number }[] = [];
  if (nonPositive > 0)
    skipped.push({ reason: "Negative or zero amount", count: nonPositive });
  if (nonZelle > 0)
    skipped.push({ reason: "Not a Zelle payment", count: nonZelle });
  if (blank > 0)
    skipped.push({ reason: "Blank description", count: blank });
  return { deposits: out, parsedRowCount, skipped };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateByDescription(deposits: Deposit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deposits) {
    m.set(d.description, (m.get(d.description) ?? 0) + d.amount);
  }
  return m;
}

export function unmatchedDeposits(
  deposits: Deposit[],
  claimedKeys: Set<string>,
): { description: string; raw: string; amount: number; date: string | null }[] {
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
