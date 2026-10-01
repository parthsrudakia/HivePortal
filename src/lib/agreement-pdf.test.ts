import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildAgreementPdf, agreementPremises } from "./agreement-pdf";

// A signature roughly like what the signing pad produces: transparent 4:1 RGBA
// PNG with a dark stroke across it.
async function fakeSignaturePng(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120">
    <path d="M20 90 C 80 20, 160 110, 240 60 S 420 40, 460 80"
      stroke="#1a1a18" stroke-width="4" fill="none" stroke-linecap="round"/>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const baseInput = {
  tenantName: "Test Tenant",
  sublessorName: "Vineet Dutta",
  propertyAddress: "161 Van Wagenen Ave, Jersey City, NJ 07306",
  roomNumber: "3",
  rent: "1650",
  securityDeposit: "1650",
  leaseStartDate: "2026-08-01",
  leaseEndDate: "2027-01-31",
  agreementDate: "2026-07-20",
  includeLetterhead: true,
};

describe("agreementPremises", () => {
  it("prints the room ahead of the address", () => {
    expect(agreementPremises(baseInput)).toBe(
      "Room 3, 161 Van Wagenen Ave, Jersey City, NJ 07306",
    );
  });

  it("falls back to the bare address for legacy inputs without a room", () => {
    expect(
      agreementPremises({ ...baseInput, roomNumber: undefined }),
    ).toBe(baseInput.propertyAddress);
  });
});

describe("buildAgreementPdf", () => {
  it("renders without signatures on one page", () => {
    const pdf = buildAgreementPdf(baseInput);
    expect(pdf.output("arraybuffer").byteLength).toBeGreaterThan(1000);
    expect(pdf.getNumberOfPages()).toBe(1);
  });

  // The signing flow stamps PNG data URLs server-side (no DOM); jsPDF's Node
  // PNG path is the least-exercised piece, so prove it end-to-end.
  it("stamps both signature PNGs server-side, still one page", async () => {
    const pngDataUrl = await fakeSignaturePng();
    const unsigned = buildAgreementPdf(baseInput);
    const signed = buildAgreementPdf({
      ...baseInput,
      sublessorSignature: { pngDataUrl },
      tenantSignature: { pngDataUrl },
      tenantSignDate: "2026-07-21",
    });
    // The embedded images must actually be in the file, not silently dropped.
    expect(signed.output("arraybuffer").byteLength).toBeGreaterThan(
      unsigned.output("arraybuffer").byteLength,
    );
    expect(signed.getNumberOfPages()).toBe(1);
  });

  it("renders the plain (no-letterhead) signed variant on one page", async () => {
    const pngDataUrl = await fakeSignaturePng();
    const pdf = buildAgreementPdf({
      ...baseInput,
      includeLetterhead: false,
      sublessorSignature: { pngDataUrl },
      tenantSignature: { pngDataUrl },
      tenantSignDate: "2026-07-21",
    });
    expect(pdf.getNumberOfPages()).toBe(1);
  });

  // Long names repeat in every clause and wrap into many extra lines — the
  // fit loop must absorb the worst realistic case on a single page.
  it("keeps a worst-case agreement (long names, prorate, signatures) on one page", async () => {
    const pngDataUrl = await fakeSignaturePng();
    const pdf = buildAgreementPdf({
      ...baseInput,
      tenantName: "Praveen Kumar Anwla Venkatasubramanian-Krishnamurthy",
      sublessorName: "Vineet Dutta Rajagopalan",
      propertyAddress:
        "442 Fifth Avenue, Apartment 24B, Suite #2478, New York, NY 10018-2799",
      proRateRent: "1234.56",
      sublessorSignature: { pngDataUrl },
      tenantSignature: { pngDataUrl },
      tenantSignDate: "2026-07-21",
    });
    expect(pdf.getNumberOfPages()).toBe(1);
  });
});
