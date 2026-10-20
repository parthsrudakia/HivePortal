/**
 * The master operator (Vineet) has full access to everything and is the only
 * one who can manage access. Everyone else's access — sections and extra
 * permissions like credentials or ledger edits — is set per user at
 * Settings → Access control (see `@/lib/section-access`).
 *
 * IMPORTANT: this email is mirrored in Postgres `has_portal_permission()`
 * (20261020143302_portal_permissions). RLS can't import this TS constant, so
 * if the master ever changes, update BOTH.
 */
const MASTER_EMAILS = new Set<string>([
  "vdutta1485@gmail.com",
]);

export function isMaster(email: string | null | undefined): boolean {
  return !!email && MASTER_EMAILS.has(email.trim().toLowerCase());
}

export const LEDGER_ADMIN_ERROR =
  "You don't have permission to change tenant ledgers. Ask Vineet to grant Financial edits.";
