/**
 * Renders src/lib/guidebook.ts into public/guidebook.pdf.
 *
 * Usage: node scripts/build-guidebook-pdf.mjs
 * Requires Google Chrome (uses headless printing). Re-run and commit the
 * PDF whenever the guidebook content changes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// guidebook.ts is plain TS with no imports — strip types by transpiling via
// a quick tsx-free hack: it only uses `export const`, so import it through
// a temp .mjs copy with the type annotation removed.
import { readFileSync } from "node:fs";
const src = readFileSync(join(root, "src/lib/guidebook.ts"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "guidebook-"));
const mjsPath = join(tmp, "guidebook.mjs");
writeFileSync(
  mjsPath,
  src.replace(/: GuidebookSection\[\]/g, "").replace(/^export type[\s\S]*?};\n/m, ""),
);
const { GUIDEBOOK_TITLE, GUIDEBOOK_UPDATED, GUIDEBOOK_SECTIONS } = await import(
  pathToFileURL(mjsPath).href
);

// ---- Tiny markdown renderer (headings, lists, bold/italic/code, tables,
// paragraphs — the only constructs the guidebook uses). ----
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let table = null; // collected rows
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeTable = () => {
    if (table) {
      const [head, ...rows] = table;
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows
            .map(
              (r) =>
                "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>",
            )
            .join("") +
          "</tbody></table>",
      );
      table = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\|/.test(line)) {
      closeList();
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      (table ??= []).push(cells);
      continue;
    }
    closeTable();
    if (/^### /.test(line)) {
      closeList();
      out.push(`<h4>${inline(line.slice(4))}</h4>`);
    } else if (/^## /.test(line)) {
      closeList();
      out.push(`<h3>${inline(line.slice(3))}</h3>`);
    } else if (/^- /.test(line)) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\d+\. /, ""))}</li>`);
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  closeTable();
  return out.join("\n");
}

const toc = GUIDEBOOK_SECTIONS.map(
  (s, i) => `<li>${i + 1}. ${esc(s.title)}</li>`,
).join("");
const body = GUIDEBOOK_SECTIONS.map(
  (s, i) =>
    `<section${i > 0 ? ' class="page-break"' : ""}><h2><span class="num">${i + 1}</span> ${esc(s.title)}</h2>${mdToHtml(s.body)}</section>`,
).join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "DM Sans", -apple-system, "Segoe UI", sans-serif; color: #1a1a18; font-size: 10.5pt; line-height: 1.55; margin: 0; }
  .cover { height: 240mm; display: flex; flex-direction: column; justify-content: center; }
  .cover .brand { color: #d4920b; font-weight: 600; letter-spacing: .2em; text-transform: uppercase; font-size: 11pt; }
  .cover h1 { font-family: Georgia, "Times New Roman", serif; font-size: 34pt; margin: 12px 0 8px; font-weight: 700; }
  .cover h1 em { color: #b87d09; }
  .cover .sub { color: #8a8378; font-size: 12pt; max-width: 120mm; }
  .cover .date { margin-top: 28px; color: #8a8378; font-size: 10pt; }
  .toc { page-break-before: always; }
  .toc h2 { font-family: Georgia, serif; font-size: 18pt; }
  .toc ul { list-style: none; padding: 0; column-count: 2; column-gap: 24px; }
  .toc li { padding: 5px 0; border-bottom: 1px solid #e8e3db; font-size: 10.5pt; break-inside: avoid; }
  section.page-break { page-break-before: always; }
  h2 { font-family: Georgia, serif; font-size: 17pt; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2.5px solid #d4920b; }
  h2 .num { color: #d4920b; margin-right: 6px; }
  h3 { font-size: 12.5pt; margin: 16px 0 6px; color: #1a1a18; }
  h4 { font-size: 11pt; margin: 12px 0 4px; color: #9a6f08; text-transform: uppercase; letter-spacing: .06em; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  code { background: #f5f2ed; border: 1px solid #e8e3db; border-radius: 4px; padding: 0 4px; font-size: 9.5pt; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt; }
  th { background: #1a1a18; color: #f5f2ed; text-align: left; padding: 6px 8px; }
  td { border: 1px solid #d8d2c8; padding: 5px 8px; vertical-align: top; }
  tr:nth-child(even) td { background: #faf8f4; }
  strong { color: #1a1a18; }
</style></head><body>
  <div class="cover">
    <div class="brand">Hive Portal</div>
    <h1>${esc(GUIDEBOOK_TITLE)}</h1>
    <div class="sub">Every automation, policy, threshold, and calculation in the portal — who gets which email and when, how the numbers are computed, and what runs on autopilot.</div>
    <div class="date">Last updated ${esc(GUIDEBOOK_UPDATED)}</div>
  </div>
  <div class="toc"><h2>Contents</h2><ul>${toc}</ul></div>
  ${body}
</body></html>`;

const htmlPath = join(tmp, "guidebook.html");
writeFileSync(htmlPath, html);

const chrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outPath = join(root, "public/guidebook.pdf");
execFileSync(chrome, [
  "--headless",
  "--disable-gpu",
  `--print-to-pdf=${outPath}`,
  "--no-pdf-header-footer",
  "--virtual-time-budget=4000",
  pathToFileURL(htmlPath).href,
]);
rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${outPath}`);
