/**
 * Lease PDFs in the `leases` bucket are named `<tenantId>/<ts>-<kind>.pdf`.
 * An unsigned agreement (attached before the tenant has signed) carries this
 * kind so the profile can label it and the signing flow can swap it out.
 */
export const UNSIGNED_LEASE_SUFFIX = "agreement-unsigned";

export function isUnsignedLeasePath(path: string | null | undefined): boolean {
  return !!path && path.endsWith(`-${UNSIGNED_LEASE_SUFFIX}.pdf`);
}
