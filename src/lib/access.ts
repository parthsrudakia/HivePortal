/**
 * Tiny access-control shim. Until we add a real roles system, only the
 * master operator (Vinny) can see /reports. Everyone else gets the rest
 * of the portal.
 */

const MASTER_EMAILS = new Set<string>([
  "vdutta1485@gmail.com",
]);

export function isMaster(email: string | null | undefined): boolean {
  return !!email && MASTER_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Tenant-ledger writes — adding/deleting charges or credits, and posting a
 * utility overcharge to tenants — are restricted to the two operators.
 * Everyone else can still view ledgers and record payments.
 *
 * IMPORTANT: this operator allowlist is mirrored in Postgres RLS policies
 * (payments, credentials, profitability_line_items, ledger side-tables, and the
 * credential_password / set_credential_password functions). RLS cannot import
 * this TS constant, so if the operator set ever changes, update BOTH here and
 * the database policies (see the 20260716* migrations) to avoid drift.
 */
const LEDGER_ADMIN_EMAILS = new Set<string>([
  "vdutta1485@gmail.com", // Vineet
  "parthrudakia@gmail.com", // Parth
]);

export function canEditLedger(email: string | null | undefined): boolean {
  return !!email && LEDGER_ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export const LEDGER_ADMIN_ERROR =
  "Only Parth or Vineet can add or remove tenant-ledger charges.";

/**
 * Unit profitability (per-unit P&L) is owner-only: the same two operators
 * as the ledger. Separate function so the intent stays readable at call
 * sites and the sets can diverge later.
 */
export function canViewProfitability(
  email: string | null | undefined,
): boolean {
  return canEditLedger(email);
}
