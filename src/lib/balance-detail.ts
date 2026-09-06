/**
 * Per-tenant balance breakdown for reminder emails — the "mini ledger".
 *
 * The running ledger (see rent.ts) explains a positive balance by its tail:
 * every entry after the last moment the account stood settled is, together,
 * exactly what the tenant currently owes. buildBalanceDetail extracts that
 * tail and, when it contains utility overcharges tied to an uploaded bill,
 * signs a time-limited link to the original statement so the tenant can see
 * the bill their charge came from.
 */

import {
  buildLedgerEntries,
  buildTenantLedgerEntries,
  type LedgerEntry,
  type LedgerEntryCharge,
  type LedgerEntryPayment,
  type LedgerTenancy,
  type RentChange,
  type TenancyLedgerInput,
} from "@/lib/rent";
import type { LedgerChargeRow } from "@/lib/rent-data";
import { formatDate } from "@/lib/date";

export type UtilityStatementLink = { label: string; url: string };

export type BalanceDetail = {
  /** Ledger lines since the account last stood settled — what the balance is made of. */
  lines: LedgerEntry[];
  /** Set when older lines were trimmed: the balance carried into the first line shown. */
  broughtForward: number | null;
  /** Signed links to the utility statements behind any overcharge in the window. */
  utilityLinks: UtilityStatementLink[];
};

/** Keep the email scannable — older history collapses into "brought forward". */
const MAX_LINES = 18;

/** Statement links live as long as a tenant might reasonably sit on the email. */
const STATEMENT_LINK_TTL_SECONDS = 60 * 60 * 24 * 30;

type UtilityBillRow = {
  id: string;
  utility_type: string | null;
  period_start: string | null;
  period_end: string | null;
  statement_date: string | null;
  statement_path: string | null;
};

// Both the cookie-session server client and the service-role client satisfy
// this; the tables/bucket involved post-date the generated types anyway.
type StorageCapableClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function statementLabel(b: UtilityBillRow): string {
  const type = (b.utility_type ?? "utility").replace(/^./, (c) =>
    c.toUpperCase(),
  );
  const period =
    b.period_start && b.period_end
      ? `${formatDate(b.period_start)} – ${formatDate(b.period_end)}`
      : b.statement_date
        ? formatDate(b.statement_date)
        : null;
  return period ? `${type} statement (${period})` : `${type} statement`;
}

export async function buildBalanceDetail(
  supabase: StorageCapableClient,
  opts: {
    tenancy: LedgerTenancy;
    payments: LedgerEntryPayment[];
    charges: LedgerChargeRow[];
    rentChanges: RentChange[];
    today: string;
  },
): Promise<BalanceDetail> {
  const entries = buildLedgerEntries(
    opts.tenancy,
    opts.payments,
    opts.charges,
    opts.today,
    opts.rentChanges,
  );
  return detailFromEntries(supabase, entries, opts.charges);
}

/**
 * Tenant-wide breakdown: the same mini ledger, but built from the tenant's
 * ONE ledger across every room, so a balance carried from a previous room is
 * explained by the lines that produced it rather than by a bare carry figure.
 */
export async function buildTenantBalanceDetail(
  supabase: StorageCapableClient,
  opts: { inputs: TenancyLedgerInput[]; today: string },
): Promise<BalanceDetail> {
  const entries = buildTenantLedgerEntries(opts.inputs, opts.today);
  return detailFromEntries(
    supabase,
    entries,
    opts.inputs.flatMap((i) => i.charges),
  );
}

async function detailFromEntries(
  supabase: StorageCapableClient,
  entries: LedgerEntry[],
  charges: LedgerEntryCharge[],
): Promise<BalanceDetail> {

  // The tail starts after the last line where the account was settled (or in
  // credit); those lines sum to the current balance by construction.
  let cut = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].balance <= 0.005) cut = i + 1;
  }
  const tail = entries.slice(cut);

  let lines = tail;
  let broughtForward: number | null = null;
  if (tail.length > MAX_LINES) {
    lines = tail.slice(tail.length - MAX_LINES);
    broughtForward = tail[tail.length - MAX_LINES - 1].balance;
  }

  // Utility overcharges in the unpaid window that trace back to an uploaded
  // bill get a signed statement link (checked against the full tail, not the
  // trimmed view — a trimmed-away charge is still part of the balance).
  const tailIds = new Set(
    tail.flatMap((e) => (e.refIds.length > 0 ? e.refIds : [e.id])),
  );
  const billIds = Array.from(
    new Set(
      charges
        .filter(
          (c) => c.kind === "utility_overage" && c.bill_id && tailIds.has(c.id),
        )
        .map((c) => c.bill_id as string),
    ),
  );

  const utilityLinks: UtilityStatementLink[] = [];
  if (billIds.length > 0) {
    const { data: bills } = await supabase
      .from("utility_bills")
      .select(
        "id, utility_type, period_start, period_end, statement_date, statement_path",
      )
      .in("id", billIds);
    for (const b of (bills ?? []) as UtilityBillRow[]) {
      if (!b.statement_path) continue;
      const { data: signed, error } = await supabase.storage
        .from("utilities")
        .createSignedUrl(b.statement_path, STATEMENT_LINK_TTL_SECONDS);
      if (error || !signed?.signedUrl) {
        console.error(
          "[balance-detail] sign statement failed:",
          error?.message,
          b.id,
        );
        continue;
      }
      utilityLinks.push({ label: statementLabel(b), url: signed.signedUrl });
    }
  }

  return { lines, broughtForward, utilityLinks };
}
