// Print-to-PDF for the phone apps (item #62, decision D1).
// In plain words: desktop and web print through the browser's print
// sheet using the @media print layout (item #26). A phone webview has
// no working print route, so on iOS/Android the Print button builds a
// real PDF of the same sheet — same header, same day blocks, same
// slot lines, same footer — and hands it to the share sheet, where
// AirPrint / Android print services / Save to Files take over.
//
// The PDF is written by hand (no library): Letter pages, the standard
// Helvetica fonts every PDF reader has built in, wrapped text lines,
// and a running page number. Content arrives as a plain model built
// by main.ts from the same plan data the HTML sheet renders, so the
// two can be checked against each other line by line.

export interface PrintSection {
  heading?: string;
  lines: string[];
}

export interface PrintModel {
  /** Sheet title lines under the app name (location/target/view/printed). */
  meta: string[];
  sections: PrintSection[];
  footer: string;
}

const PAGE_W = 612; // Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;
const GREEN = "0.043 0.29 0.18"; // #0B4A2E as an RGB operator

/** Characters WinAnsi (the standard encoding for built-in fonts) can
 *  show, mapped from the few specials the sheet uses. Anything else
 *  unmapped becomes "?" — better a placeholder than a broken file. */
const WINANSI_EXTRA: Record<string, number> = {
  "–": 0x96, // en dash
  "—": 0x97, // em dash
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "…": 0x85,
};

/** Encode one string as PDF literal-string bytes (returned as a JS
 *  string of ASCII, using octal escapes for bytes above 126). The
 *  star/check symbols the slot labels use are not in WinAnsi: the
 *  star is dropped (its word "Best" carries the meaning) and the
 *  check becomes a lowercase v, matching the sheet's plain-text feel. */
function pdfText(s: string): string {
  const cleaned = s.replace(/★/g, "").replace(/✓/g, "v").replace(/⚠/g, "");
  let out = "";
  for (const ch of cleaned) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "(" || ch === ")" || ch === "\\") {
      out += "\\" + ch;
    } else if (code >= 32 && code <= 126) {
      out += ch;
    } else if (code >= 160 && code <= 255) {
      out += "\\" + code.toString(8).padStart(3, "0");
    } else if (WINANSI_EXTRA[ch] !== undefined) {
      out += "\\" + WINANSI_EXTRA[ch].toString(8).padStart(3, "0");
    } else {
      out += "?";
    }
  }
  return out;
}

/** Rough Helvetica advance width: average glyph ~0.5 em (regular) or
 *  ~0.53 em (bold). Wrapping a little early is fine; overflowing the
 *  page edge is not, so the estimates lean wide. */
function wrapLine(text: string, size: number, bold: boolean): string[] {
  const perChar = size * (bold ? 0.53 : 0.5);
  const maxChars = Math.max(10, Math.floor(CONTENT_W / perChar));
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) lines.push(cur);
      for (let i = 0; i < w.length; i += maxChars) lines.push(w.slice(i, i + maxChars));
      cur = "";
    } else if ((cur + " " + w).trim().length <= maxChars) {
      cur = (cur + " " + w).trim();
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface PlacedLine {
  text: string;
  size: number;
  bold: boolean;
  color?: string;
  gapBefore: number; // extra points above the line
}

/** Lay the model out into pages of drawable lines. */
function layout(model: PrintModel): PlacedLine[][] {
  const all: PlacedLine[] = [];
  all.push({ text: "ZERO LIGHT", size: 20, bold: true, color: GREEN, gapBefore: 0 });
  all.push({ text: "Your best times to hunt and fish.", size: 10.5, bold: false, gapBefore: 2 });
  for (const m of model.meta) {
    all.push({ text: m, size: 10.5, bold: false, gapBefore: 2 });
  }
  for (const sec of model.sections) {
    if (sec.heading) {
      all.push({ text: sec.heading, size: 13, bold: true, color: GREEN, gapBefore: 12 });
    }
    for (const line of sec.lines) {
      const wrapped = wrapLine(line, 10.5, false);
      wrapped.forEach((w, i) => {
        all.push({ text: w, size: 10.5, bold: false, gapBefore: i === 0 ? 3 : 0 });
      });
    }
  }
  const footerWrapped = wrapLine(model.footer, 8.5, false);
  footerWrapped.forEach((w, i) => {
    all.push({ text: w, size: 8.5, bold: false, gapBefore: i === 0 ? 14 : 0 });
  });

  const pages: PlacedLine[][] = [];
  let page: PlacedLine[] = [];
  let y = PAGE_H - MARGIN;
  for (const line of all) {
    const lh = line.size * 1.35;
    if (y - line.gapBefore - lh < MARGIN) {
      pages.push(page);
      page = [];
      y = PAGE_H - MARGIN;
    }
    y -= line.gapBefore;
    page.push(line);
    y -= lh;
  }
  if (page.length) pages.push(page);
  return pages;
}

/** Build the PDF file bytes for one print model. */
export function buildPrintPdf(model: PrintModel): Uint8Array {
  const pages = layout(model);
  const objects: string[] = [];
  // Object ids: 1 catalog, 2 pages, 3/4 fonts, then per page a page
  // object and a content object.
  const pageObjIds = pages.map((_, i) => 5 + i * 2);
  const contentObjIds = pages.map((_, i) => 6 + i * 2);

  const pageContents = pages.map((lines, pi) => {
    let y = PAGE_H - MARGIN;
    let s = "";
    for (const line of lines) {
      const lh = line.size * 1.35;
      y -= line.gapBefore;
      y -= lh;
      const font = line.bold ? "F2" : "F1";
      const color = line.color ? `${line.color} rg ` : "0 0 0 rg ";
      s += `BT ${color}/${font} ${line.size} Tf ${MARGIN} ${y.toFixed(1)} Td (${pdfText(line.text)}) Tj ET\n`;
    }
    // Page number, small and centered at the bottom margin.
    s += `BT 0.45 0.45 0.45 rg /F1 8.5 Tf ${(PAGE_W / 2 - 14).toFixed(1)} 30 Td (Page ${pi + 1} of ${pages.length}) Tj ET\n`;
    return s;
  });

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  pages.forEach((_, i) => {
    objects[pageObjIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
    const content = pageContents[i];
    objects[contentObjIds[i]] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // Every character is ASCII by construction (pdfText escapes the
  // rest), so a plain byte-per-char conversion is exact.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
