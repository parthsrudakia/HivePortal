import { z } from "zod";

// Emergency contacts are collected from tenants through a public token form
// (see the emergency_contacts migrations). Tenants reach it only on the random
// EMERGENCY_FORM_ORIGIN host as https://<host>/<token>; the proxy rewrites that
// to /emergency-contact/<token> and 404s everything else on that host. Links
// are valid for 48 hours from the send. The request email is
// sendEmergencyContactRequest in email.ts.

/** How long a form link stays valid after it is sent. */
export const LINK_TTL_MS = 48 * 60 * 60 * 1000;

/** Expiry timestamp (ISO) for a link sent now. */
export function linkExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + LINK_TTL_MS).toISOString();
}

/** A link is usable only once sent (expires_at set) and before it expires. */
export function linkActive(expiresAt: string | null, now = Date.now()): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() > now;
}

export const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The random form origin, or null when unconfigured. */
export function emergencyFormOrigin(): string | null {
  const raw = process.env.EMERGENCY_FORM_ORIGIN?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** Host of the form origin (for the proxy), or null when unconfigured. */
export function emergencyFormHost(): string | null {
  const origin = emergencyFormOrigin();
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Public URL of a tenant's emergency-contact form. Throws when the random
 * origin is unconfigured: links must never fall back to the portal's domain.
 */
export function emergencyContactUrl(token: string): string {
  const origin = emergencyFormOrigin();
  if (!origin) {
    throw new Error(
      "EMERGENCY_FORM_ORIGIN is not configured, so emergency-contact links can't be built.",
    );
  }
  return `${origin}/${token}`;
}

/** Digits only, so "+1 (617) 555-0100" and "617-555-0100" compare equal. */
export function phoneDigits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Last 10 digits: drops a leading country code for the same-as-mine check. */
function phoneKey(s: string): string {
  return phoneDigits(s).slice(-10);
}

// Every field is mandatory. Shared by the client form (instant feedback) and
// the server action (the real gate).
export const emergencyContactSchema = z.object({
  contactName: z
    .string()
    .trim()
    .min(2, "Enter your contact's full name.")
    .max(120, "That name is too long."),
  relationship: z
    .string()
    .trim()
    .min(2, "Tell us how this person is related to you.")
    .max(60, "Keep the relationship short, e.g. Mother or Friend."),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address.")),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s().-]+$/, "Enter a valid phone number.")
    .refine((v) => {
      const n = phoneDigits(v).length;
      return n >= 7 && n <= 15;
    }, "Enter a valid phone number, including the country code if outside the US."),
});

export type EmergencyContactInput = z.infer<typeof emergencyContactSchema>;

/**
 * The emergency contact has to be someone else. Returns an error message when
 * the tenant entered their own email or phone, otherwise null.
 */
export function selfContactError(
  input: EmergencyContactInput,
  tenant: { email: string | null; phone: string | null },
): string | null {
  if (tenant.email && input.contactEmail === tenant.email.trim().toLowerCase()) {
    return "That's your own email. Please enter your emergency contact's email.";
  }
  if (tenant.phone && phoneKey(tenant.phone) && phoneKey(input.contactPhone) === phoneKey(tenant.phone)) {
    return "That's your own phone number. Please enter your emergency contact's number.";
  }
  return null;
}
