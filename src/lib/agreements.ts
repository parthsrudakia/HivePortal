/**
 * Hive agreement generation — built in-process with `@/lib/agreement-pdf`
 * (ported from the agreement-gen project). No network calls: the old
 * agreements.hiveny.com edge function is no longer used.
 *
 * The base64 return shape is kept so the PDF drops straight into email
 * attachments without juggling binary streams.
 */

import {
  buildAgreementPdf,
  agreementFilename,
  type SignatureImage,
} from "@/lib/agreement-pdf";

export type AgreementInput = {
  tenantName: string;
  sublessorName: string;
  propertyAddress: string;
  /** Room within the unit, e.g. "3" or "B" — mandatory on every agreement. */
  roomNumber: string;
  rent: string;
  securityDeposit: string;
  leaseStartDate: string; // "YYYY-MM-DD"
  leaseEndDate: string; // "YYYY-MM-DD"
  agreementDate: string; // "YYYY-MM-DD"
  /** New York units go out without letterhead → pass false. Defaults to true. */
  includeLetterhead?: boolean;
  proRateRent?: string;
  /** Stamped above the sublessor line (send + sign time). */
  sublessorSignature?: SignatureImage;
  /** Stamped above the sublessee line (sign time only). */
  tenantSignature?: SignatureImage;
  /** "YYYY-MM-DD" — fills the sublessee Date line at sign time. */
  tenantSignDate?: string;
};

export type GeneratedAgreement = {
  filename: string;
  base64: string;
};

// The tenant name flows into the filename; strip anything that isn't
// filename-safe and force a .pdf extension before the name goes into a MIME
// attachment header.
function safePdfFilename(name: string): string {
  const cleaned = name.replace(/[^\w. -]+/g, "_").replace(/\.+$/, "").trim();
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || "agreement"}.pdf`;
}

/** Attachment-safe filename for a tenant's agreement PDF. */
export function agreementPdfFilename(tenantName: string): string {
  return safePdfFilename(agreementFilename(tenantName));
}

/** Generate the agreement PDF and return it as base64. Throws on bad input. */
export async function generateAgreementPdf(
  input: AgreementInput,
): Promise<GeneratedAgreement> {
  const pdf = buildAgreementPdf({
    tenantName: input.tenantName,
    sublessorName: input.sublessorName,
    propertyAddress: input.propertyAddress,
    roomNumber: input.roomNumber,
    rent: input.rent,
    securityDeposit: input.securityDeposit,
    leaseStartDate: input.leaseStartDate,
    leaseEndDate: input.leaseEndDate,
    agreementDate: input.agreementDate,
    includeLetterhead: input.includeLetterhead ?? true,
    proRateRent: input.proRateRent,
    sublessorSignature: input.sublessorSignature,
    tenantSignature: input.tenantSignature,
    tenantSignDate: input.tenantSignDate,
  });

  const base64 = Buffer.from(pdf.output("arraybuffer")).toString("base64");
  return {
    filename: safePdfFilename(agreementFilename(input.tenantName)),
    base64,
  };
}
