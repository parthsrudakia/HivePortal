/**
 * Hive sublease agreement PDF builder, ported in-house from the
 * agreement-gen project (github.com/parth-hive/agreement-gen) so the portal
 * no longer depends on the agreements.hiveny.com edge function.
 *
 * Pure jsPDF — no filesystem, DOM, or network access — so the same module
 * runs on the server (email attachments via `@/lib/agreements`) and in the
 * browser (direct downloads on /agreements).
 */

import { jsPDF } from "jspdf";
import { drawHiveLetterhead, LETTERHEAD_GOLD } from "./agreement-logo";

export type AgreementPdfData = {
  tenantName: string;
  sublessorName: string;
  propertyAddress: string;
  rent: string;
  securityDeposit: string;
  /** "YYYY-MM-DD" */
  leaseStartDate: string;
  /** "YYYY-MM-DD" */
  leaseEndDate: string;
  /** "YYYY-MM-DD" */
  agreementDate: string;
  /** New York units go out without letterhead. */
  includeLetterhead: boolean;
  proRateRent?: string;
};

// Date-only strings are formatted from their Y/M/D parts directly. Going
// through `new Date("YYYY-MM-DD")` parses as UTC midnight, and this server is
// pinned to America/New_York (src/instrumentation.ts) — every lease date
// would render one day early.
/** "2026-07-01" → "07/01/26" */
function formatShortDate(dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Invalid agreement date "${dateStr}" — expected YYYY-MM-DD.`);
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Token = { text: string; bold: boolean; spaceBefore: boolean };

/**
 * Split text into word tokens, bolding exact occurrences of the given
 * phrases (whole names/addresses, bounded so a name inside another word
 * never bolds). Phrase-level matching keeps short words like "E" or "NY"
 * inside an address bold along with the rest of it.
 */
function tokenize(text: string, boldPhrases: string[]): Token[] {
  const parts = [...new Set(boldPhrases.map((p) => p.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const runs: { text: string; bold: boolean }[] = [];
  if (parts.length === 0) {
    runs.push({ text, bold: false });
  } else {
    const re = new RegExp(
      `(?<![A-Za-z0-9])(${parts.join("|")})(?![A-Za-z0-9])`,
      "g",
    );
    // String.split with a capture group alternates non-match / match pieces.
    text.split(re).forEach((piece, i) => {
      if (piece) runs.push({ text: piece, bold: i % 2 === 1 });
    });
  }

  const tokens: Token[] = [];
  // Carries across run boundaries: whitespace at the end of one run puts the
  // space before the first token of the next.
  let pendingSpace = false;
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        pendingSpace = true;
        continue;
      }
      // A run boundary mid-word (e.g. a bold name followed by "." or ",")
      // arrives with pendingSpace=false and glues to the previous token.
      tokens.push({ text: piece, bold: run.bold, spaceBefore: pendingSpace });
      pendingSpace = false;
    }
  }
  if (tokens.length > 0) tokens[0].spaceBefore = false;
  return tokens;
}

/** Per-document layout context: fonts, margins, and page-break handling. */
type Layout = {
  pdf: jsPDF;
  pageWidth: number;
  /** y beyond which content must flow to the next page */
  bottom: number;
  /** y to restart at on a fresh page */
  top: number;
};

function textWidth(pdf: jsPDF, text: string, bold: boolean): number {
  pdf.setFont("helvetica", bold ? "bold" : "normal");
  return pdf.getTextWidth(text);
}

function breakPage(layout: Layout, y: number, needed: number): number {
  if (y + needed <= layout.bottom) return y;
  layout.pdf.addPage();
  return layout.top;
}

/**
 * Write a paragraph, bolding the given phrases. Wrapping measures every word
 * in the weight it will actually render (bold names are wider than normal
 * text — measuring in normal weight overshoots the right margin), and flows
 * to a new page rather than past the bottom edge.
 */
function writeWithBold(
  layout: Layout,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  boldPhrases: string[],
  fontSize = 10,
): number {
  const { pdf } = layout;
  pdf.setFontSize(fontSize);
  const lineHeight = 4.2;
  const spaceWidth = textWidth(pdf, " ", false);

  // Greedy wrap over tokens, then draw line by line.
  const lines: Token[][] = [];
  let line: Token[] = [];
  let lineWidth = 0;
  for (const token of tokenize(text, boldPhrases)) {
    const w = textWidth(pdf, token.text, token.bold);
    const lead = line.length > 0 && token.spaceBefore ? spaceWidth : 0;
    if (line.length > 0 && lineWidth + lead + w > maxWidth) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    line.push(token);
    lineWidth += (line.length > 1 && token.spaceBefore ? spaceWidth : 0) + w;
  }
  if (line.length > 0) lines.push(line);

  for (const tokens of lines) {
    y = breakPage(layout, y, lineHeight);
    let currentX = x;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (i > 0 && token.spaceBefore) currentX += spaceWidth;
      pdf.setFont("helvetica", token.bold ? "bold" : "normal");
      pdf.text(token.text, currentX, y);
      currentX += pdf.getTextWidth(token.text);
    }
    y += lineHeight;
  }

  pdf.setFont("helvetica", "normal");
  return y;
}

export function agreementFilename(tenantName: string): string {
  return `${tenantName} Agreement.pdf`;
}

/** Build the agreement document. Callers pick the output format they need. */
export function buildAgreementPdf(data: AgreementPdfData): jsPDF {
  const pdf = new jsPDF("p", "mm", "letter");
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  const layout: Layout = {
    pdf,
    pageWidth,
    bottom: pageHeight - 18,
    top: 18,
  };
  let yPos = 18;

  // Tighter spacing when letterhead is present so a typical agreement stays
  // on one page.
  const hasLetterhead = data.includeLetterhead;
  const clauseSpacing = hasLetterhead ? 1.8 : 2.5;
  const sectionSpacing = hasLetterhead ? 5 : 8;

  if (hasLetterhead) {
    // Vector lockup from hiveny.com: gold hive glyph + HIVE wordmark. The
    // icon is deliberately modest next to the wordmark, matching the site.
    const logoHeight = 9;
    drawHiveLetterhead(pdf, margin, yPos, logoHeight);

    // Contact details on top right. Four lines at 3.6mm leading run taller
    // than the logo, so the header height below follows the contact block.
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);
    const rightX = pageWidth - margin;
    let contactY = yPos + 2;
    pdf.text("917-622-9847", rightX, contactY, { align: "right" });
    contactY += 3.6;
    pdf.text("Vineet.Dutta@HiveNY.com", rightX, contactY, { align: "right" });
    contactY += 3.6;
    pdf.text("442 5th Avenue Suite #2478", rightX, contactY, { align: "right" });
    contactY += 3.6;
    pdf.text("New York, NY 10018", rightX, contactY, { align: "right" });

    yPos = contactY + 2.5;

    // Honey-gold divider line (brand accent #d4920b)
    pdf.setDrawColor(...LETTERHEAD_GOLD);
    pdf.setLineWidth(0.7);
    pdf.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 5;
  }

  const names = [data.tenantName, data.sublessorName];
  // Clause 11 refers to the sublessor by first name; bold that too.
  const namesAndFirsts = [...names, data.sublessorName.split(" ")[0]];

  // Introduction paragraph with bold names and address
  const intro = `This agreement is made between ${data.tenantName} and ${data.sublessorName} for the period beginning ${formatShortDate(data.leaseStartDate)}, and ending ${formatShortDate(data.leaseEndDate)}, and will convert to a month-to-month at ${data.propertyAddress}.`;
  yPos = writeWithBold(layout, intro, margin, yPos, contentWidth, [
    ...names,
    data.propertyAddress,
  ]);
  yPos += 4;

  // Rent, optional prorated rent, security deposit
  pdf.setFontSize(10);
  pdf.text(`1. Rent: $${data.rent}`, margin + 4, yPos);
  yPos += hasLetterhead ? 4 : 5;
  let clauseNumber = 2;
  if (data.proRateRent && data.proRateRent.trim() !== "") {
    pdf.text(`${clauseNumber}. Prorated Rent: $${data.proRateRent}`, margin + 4, yPos);
    yPos += hasLetterhead ? 4 : 5;
    clauseNumber++;
  }
  pdf.text(`${clauseNumber}. Security Deposit: $${data.securityDeposit}`, margin + 4, yPos);
  yPos += sectionSpacing + (hasLetterhead ? 4 : 0);

  pdf.text("The parties agree:", margin, yPos);
  yPos += hasLetterhead ? 9 : 11;

  const clauses = [
    `If the monthly electric bill exceeds $200, the amount over $200 will be divided equally among the number of occupants residing in the unit. ${data.tenantName} will be responsible for his/her share of the excess charge.`,
    `Rent will be paid on the first of the month; if payment is not received by the 3rd of the month, a $50 late fee will be applied.`,
    `Both ${data.sublessorName} and ${data.tenantName} will be required to give a 30-day notice period in the event parties want to terminate the agreement earlier.`,
  ];

  const subClauses = [
    `${data.tenantName} must provide 30 days' notice before the end date of the agreement if he/she decides to vacate by the end of the agreement.`,
    `If a 30-day notice is not given, the security deposit will be forfeited by ${data.tenantName}.`,
    `${data.tenantName} will be charged for a full month's rent in the event the move takes place in the middle of the month.`,
  ];

  const remainingClauses = [
    `Security deposit will be returned within three weeks of moving out.`,
    `Smoking is strictly prohibited within the apartment and building. If ${data.tenantName} is found smoking in the apartment, a $1,000 fine will be issued.`,
    `${data.tenantName} agrees to adhere to cleanliness standards or additional incurred charges for maid services will be required.`,
    `${data.tenantName} shall pay for all property damage he/she is responsible for in the event something happens during sublease.`,
    `A move out cleaning fee of $100 will be applied.`,
    `A joint inspection of the premises shall be conducted by ${data.sublessorName} and ${data.tenantName} recording any damage or deficiencies that exist at the start of the sublease period.`,
    `${data.tenantName} shall be liable for the cost of any cleaning or repair to correct damages caused by ${data.tenantName} at the end of the period if not recorded at the start of the agreement, normal wear and tear excepted. Security deposit will be refunded after vacating the apartment given there is no damage (except normal wear and tear) found prior to vacating.`,
    `${data.tenantName} must reimburse ${data.sublessorName} for the following fees and expenses incurred by ${data.sublessorName.split(" ")[0]}: Any legal fees and disbursements for the preparation and service of legal notices; legal actions or proceedings brought by ${data.sublessorName} against ${data.tenantName} because of a default by ${data.tenantName} under this agreement; or for defending lawsuits brought against ${data.sublessorName} because of the actions of ${data.tenantName}, or any associates of ${data.tenantName}.`,
  ];

  for (let i = 0; i < clauses.length; i++) {
    yPos = writeWithBold(layout, `${1 + i}. ${clauses[i]}`, margin + 4, yPos, contentWidth - 8, names);
    yPos += clauseSpacing;
    if (i === 2) {
      for (let j = 0; j < subClauses.length; j++) {
        yPos = writeWithBold(
          layout,
          `${String.fromCharCode(97 + j)}. ${subClauses[j]}`,
          margin + 12,
          yPos,
          contentWidth - 16,
          names,
        );
        yPos += hasLetterhead ? 1 : 1.5;
      }
    }
  }

  for (let i = 0; i < remainingClauses.length; i++) {
    yPos = writeWithBold(layout, `${4 + i}. ${remainingClauses[i]}`, margin + 4, yPos, contentWidth - 8, namesAndFirsts);
    yPos += clauseSpacing;
  }

  // Signature section — kept together: if it doesn't fit, it moves to the
  // next page whole rather than losing the sublessee lines off the bottom.
  yPos += hasLetterhead ? 3 : 5;
  const signatureHeight = 24;
  yPos = breakPage(layout, yPos, signatureHeight);

  pdf.setFontSize(10);
  const signatureLine = "__________________________";
  const dateLine = "____________________";
  const dateLineWidth = textWidth(pdf, dateLine, false);
  const dateX = pageWidth - margin - dateLineWidth;
  const dateCenterX = dateX + dateLineWidth / 2;

  const signatureRow = (role: string, name: string, filledDate?: string) => {
    pdf.setFont("helvetica", "normal");
    pdf.text(`${role}: `, margin, yPos);
    pdf.setFont("helvetica", "bold");
    pdf.text(name, margin + pdf.getTextWidth(`${role}: `), yPos);
    pdf.setFont("helvetica", "normal");
    pdf.text("Date", dateCenterX, yPos, { align: "center" });
    yPos += 7;
    pdf.text(signatureLine, margin, yPos);
    pdf.text(dateLine, dateX, yPos);
    if (filledDate) {
      // Sits just above the underscores, like a filled-in form field.
      pdf.text(filledDate, dateCenterX, yPos - 0.8, { align: "center" });
    }
    yPos += 10;
  };

  signatureRow("Sublessor", data.sublessorName, formatShortDate(data.agreementDate));
  signatureRow("Sublessee", data.tenantName);

  return pdf;
}
