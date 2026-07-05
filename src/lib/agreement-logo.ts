// Hive letterhead lockup, drawn as vectors so it stays crisp at any size and
// adds nothing to the PDF weight. Geometry and styling mirror the hiveny.com
// nav logo: the gold hive glyph (inline SVG, viewBox 0 0 80 100) next to an
// uppercase letterspaced "HIVE" wordmark over the tagline.

import type { jsPDF } from "jspdf";

// Brand tokens from hiveny.com (light background variant).
const GOLD = [212, 146, 11] as const; // #d4920b honey gold
const INK = [26, 26, 24] as const; // #1a1a18
const MUTED = [138, 131, 120] as const; // #8a8378

// The icon's shapes, copied from the site SVG (fill-only, all gold).
const CIRCLES = [
  { cx: 40, cy: 8, r: 4.5 },
  { cx: 40, cy: 88, r: 4 },
];
const BARS = [
  { x: 28, y: 18, w: 24 },
  { x: 18, y: 32, w: 44 },
  { x: 15, y: 46, w: 50 },
  { x: 18, y: 60, w: 44 },
  { x: 28, y: 74, w: 24 },
]; // each 6 tall with fully rounded (rx 3) ends

/**
 * Draw the letterhead lockup with the icon's top-left corner at (x, y).
 * `iconHeight` is in document units (mm). Returns the lockup's footprint.
 * Leaves the PDF text color reset to black.
 */
export function drawHiveLetterhead(
  pdf: jsPDF,
  x: number,
  y: number,
  iconHeight: number,
): { width: number; height: number } {
  const s = iconHeight / 100; // SVG viewBox is 80 x 100
  pdf.setFillColor(...GOLD);
  for (const c of CIRCLES) {
    pdf.circle(x + c.cx * s, y + c.cy * s, c.r * s, "F");
  }
  for (const b of BARS) {
    pdf.roundedRect(x + b.x * s, y + b.y * s, b.w * s, 6 * s, 3 * s, 3 * s, "F");
  }

  // Text block beside the icon, sized off the site's lockup ratios: the
  // wordmark's cap height is ~44% of the icon height (nav icon 30px next to
  // an 18.4px HIVE), the tagline ~42% of the wordmark, gap ~40% of icon
  // height. Helvetica cap height ≈ 0.72em; 1pt = 0.3528mm.
  const wordPt = (0.44 * iconHeight) / (0.3528 * 0.72);
  const tagPt = wordPt * 0.42;
  const textX = x + 80 * s + iconHeight * 0.4;

  // Center the two-line block against the icon.
  const capH = 0.44 * iconHeight;
  const tagGap = iconHeight * 0.4;
  const blockH = capH + tagGap;
  const wordY = y + (iconHeight - blockH) / 2 + capH;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(wordPt);
  pdf.setTextColor(...INK);
  pdf.text("HIVE", textX, wordY, { charSpace: wordPt * 0.047 });

  const tagY = wordY + tagGap;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(tagPt);
  pdf.setTextColor(...MUTED);
  pdf.text("CITY LIVING, MADE SIMPLE", textX, tagY, { charSpace: tagPt * 0.06 });

  pdf.setTextColor(0, 0, 0);
  const tagWidth = pdf.getTextWidth("CITY LIVING, MADE SIMPLE") + tagPt * 0.06 * 24;
  return { width: 80 * s + iconHeight * 0.4 + tagWidth, height: iconHeight };
}

/** Divider color under the letterhead — the brand's honey gold. */
export const LETTERHEAD_GOLD = GOLD;
