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
