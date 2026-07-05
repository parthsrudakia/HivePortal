/**
 * Best-effort compression for uploaded utility statements before storage.
 * Extraction always runs on the original bytes; only the stored copy is
 * compressed, and only when that actually makes it smaller.
 *
 * - PDFs: rewritten with pdf-lib using object streams, which compacts the
 *   xref structure and drops incremental-save leftovers. Lossless.
 * - Images (photos of bills): downscaled to a readable ceiling and
 *   re-encoded as WebP. Lossy but far above what OCR/eyes need.
 */

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

export type CompressedStatement = {
  data: Buffer;
  mediaType: string;
};

const IMAGE_MAX_EDGE = 2200; // px — keeps small print comfortably legible
const IMAGE_QUALITY = 72;

export async function compressStatement(
  original: Buffer,
  mediaType: string,
): Promise<CompressedStatement> {
  try {
    if (mediaType === "application/pdf") {
      const doc = await PDFDocument.load(original, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      const out = Buffer.from(await doc.save({ useObjectStreams: true }));
      return out.length < original.length
        ? { data: out, mediaType }
        : { data: original, mediaType };
    }

    if (mediaType.startsWith("image/")) {
      const out = await sharp(original)
        .rotate() // bake in EXIF orientation before it's stripped
        .resize({
          width: IMAGE_MAX_EDGE,
          height: IMAGE_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: IMAGE_QUALITY })
        .toBuffer();
      return out.length < original.length
        ? { data: out, mediaType: "image/webp" }
        : { data: original, mediaType };
    }
  } catch {
    // Compression is opportunistic — a malformed file still gets stored as-is.
  }
  return { data: original, mediaType };
}
