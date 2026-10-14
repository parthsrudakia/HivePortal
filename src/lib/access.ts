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
 * (payments, credentials, profitability_line_items, ledger side-tables, the
 * credential_password / set_credential_password functions, and — via
 * is_financial_operator() — audit_log / email_log / sms_log / email_queue
 * reads and notification_recipients writes). RLS cannot import this TS
 * constant, so if the operator set ever changes, update BOTH here and the
 * database policies (see the 20260716 and 20260717 migrations) to avoid drift.
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

/**
 * The admin logs (audit / email / text) and notification settings are
 * operator-only: Vineet and Parth. Same set as the ledger admins; separate
 * function so call sites read as access checks and the sets can diverge later.
 */
export function isOperator(email: string | null | undefined): boolean {
  return canEditLedger(email);
}

/**
 * The credentials vault — seeing entries at all, revealing/copying passwords,
 * adding/editing/deleting — is operator-only: Vineet and Parth. Mirrored in
 * the credentials RLS policies and the credential_password /
 * set_credential_password functions (20261014050914_credentials_operator_only_read).
 */
export function canManageCredentials(
  email: string | null | undefined,
): boolean {
  return isOperator(email);
}
