import { z } from "zod";

// Emergency contacts are collected from tenants through a public token form at
// /emergency-contact/<token> (see the emergency_contacts migration). The
// request email is sendEmergencyContactRequest in email.ts.

/** Public URL of a tenant's emergency-contact form. */
export function emergencyContactUrl(token: string): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://hive-portal-1485.vercel.app"
  ).replace(/\/+$/, "");
  return `${base}/emergency-contact/${token}`;
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
