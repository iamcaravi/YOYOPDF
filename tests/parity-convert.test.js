import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import * as pdfLib from "pdf-lib";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFPage } from "pdf-lib";
import XLSX from "xlsx";
import JSZip from "jszip";

// pdf-lib's addPage rejects cross-realm arrays (vm sandbox arrays fail
// its instanceof Array check). The sandbox gets a PDFDocument subclass
// that normalises page-size arrays to the outer realm; in the browser
// there is only one realm and the shipped code needs no such shim.
class SandboxPDFDocument extends PDFDocument {
  static async create(...args) {
    const d = await super.create(...args);
    Object.setPrototypeOf(d, SandboxPDFDocument.prototype);
    return d;
  }
  addPage(page) {
    return super.addPage(Array.isArray(page) ? Array.from(page) : page);
  }
}

// pdf-lib validates draw options with `instanceof Object`, which
// cross-realm option literals (built inside the vm sandbox) fail. Copy
// option objects into this realm before delegating; again, a harness
// shim only — the browser has a single realm.
const _drawLine = PDFPage.prototype.drawLine;
PDFPage.prototype.drawLine = function (options) {
  return _drawLine.call(this, { ...options, start: { ...options.start }, end: { ...options.end } });
};
const _drawRectangle = PDFPage.prototype.drawRectangle;
PDFPage.prototype.drawRectangle = function (options) {
  return _drawRectangle.call(this, { ...options });
};

// Parity Wave B (converters): the shipped classic scripts are loaded
// into one vm sandbox, exactly as tests/pdf-to-excel.test.js does for
// doc-export-builders.js, so pdf-convert-tools.js can call
// buildPageLayout/layoutToSheetRows/buildMixedDocx/buildEditablePptx
// as it does in the browser. pdf-convert-tools.js only touches the DOM
// inside TOOLS.* handlers (never called here); the pure helpers and
// builders under test need only the globals stubbed below.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sandbox;
beforeAll(() => {
  sandbox = vm.createContext({
    console, pdfjsLib, XLSX, JSZip, setTimeout, clearTimeout,
    PDFLib: pdfLib, PDFDocument: SandboxPDFDocument, StandardFonts, rgb,
    TOOLS: {},
    ensureJSZip: async () => {},
    ensureXLSX: async () => {},
    winAnsiSafe: (s) => String(s == null ? "" : s),
  });
  vm.runInContext(readFileSync(resolve(ROOT, "js/core/doc-export-builders.js"), "utf8"), sandbox, { filename: "doc-export-builders.js" });
  vm.runInContext(readFileSync(resolve(ROOT, "js/core/pptx-export.js"), "utf8"), sandbox, { filename: "pptx-export.js" });
  vm.runInContext(readFileSync(resolve(ROOT, "js/tools/pdf-convert-tools.js"), "utf8"), sandbox, { filename: "pdf-convert-tools.js" });
});

async function loadBlocks(pdfBytes) {
  const pdoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const pages = [];
  for (let i = 1; i <= pdoc.numPages; i++) {
    const pdfPage = await pdoc.getPage(i);
    const visuals = await sandbox.extractPageVisuals(pdoc, i);
    const blocks = await sandbox.extractPageBlocks(pdoc, i, visuals);
    blocks._pageWidthPt = pdfPage.view[2] - pdfPage.view[0];
    blocks._pageHeightPt = pdfPage.view[3] - pdfPage.view[1];
    blocks._visuals = visuals;
    pages.push(blocks);
  }
  return pages;
}

function drawRuledGrid(page, { x0, yTop, colWidths, rowHeight, nRows }) {
  const colXs = [x0];
  colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
  const totalWidth = colXs[colXs.length - 1] - x0;
  const totalHeight = rowHeight * nRows;
  for (let r = 0; r <= nRows; r++) {
    const y = yTop - r * rowHeight;
    page.drawRectangle({ x: x0, y: y - 0.36, width: totalWidth, height: 0.72, color: rgb(0, 0, 0) });
  }
  for (let c = 0; c <= colWidths.length; c++) {
    page.drawRectangle({ x: colXs[c] - 0.36, y: yTop - totalHeight, width: 0.72, height: totalHeight, color: rgb(0, 0, 0) });
  }
  return { colXs, rowYs: Array.from({ length: nRows + 1 }, (_, r) => yTop - r * rowHeight) };
}

function drawGridText(page, font, { colXs, rowYs }, rows) {
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (!text) return;
      page.drawText(String(text), { x: colXs[c] + 4, y: rowYs[r] - 16, size: 10, font });
    });
  });
}

async function buildTwoPageRuledTablePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const header = ["ID", "Name", "Phone"];
  // Page 2's grid is shifted +5pt so the shared column grid must merge
  // the two pages' bounds (the point of the feed-forward pass).
  const page1 = doc.addPage([595, 842]);
  const g1 = drawRuledGrid(page1, { x0: 40, yTop: 780, colWidths: [80, 160, 100], rowHeight: 24, nRows: 3 });
  drawGridText(page1, font, g1, [header, ["1", "Alpha Person", "9876543210"], ["2", "Beta Person", "0123456"]]);
  const page2 = doc.addPage([595, 842]);
  const g2 = drawRuledGrid(page2, { x0: 45, yTop: 780, colWidths: [80, 160, 100], rowHeight: 24, nRows: 3 });
  drawGridText(page2, font, g2, [header, ["3", "Gamma Person", "9998887770"], ["4", "Delta Person", "5551234567"]]);
  return new Uint8Array(await doc.save());
}

describe("parseConverterPageRange", () => {
  it("blank means all pages", () => {
    expect(sandbox.parseConverterPageRange("", 10)).toEqual({ all: true });
    expect(sandbox.parseConverterPageRange("   ", 10)).toEqual({ all: true });
  });
  it("parses lists and ranges", () => {
    const r = sandbox.parseConverterPageRange("1,3,5-8", 10);
    expect([...r.pages].sort((a, b) => a - b)).toEqual([1, 3, 5, 6, 7, 8]);
  });
  it("drops out-of-range numbers but keeps valid ones", () => {
    const r = sandbox.parseConverterPageRange("1,99", 5);
    expect([...r.pages]).toEqual([1]);
  });
  it("rejects reversed ranges, zero, and non-numbers", () => {
    expect(sandbox.parseConverterPageRange("8-5", 10).error).toBe(true);
    expect(sandbox.parseConverterPageRange("0", 10).error).toBe(true);
    expect(sandbox.parseConverterPageRange("abc", 10).error).toBe(true);
    expect(sandbox.parseConverterPageRange("1,,3", 10).error).toBe(true);
    expect(sandbox.parseConverterPageRange("99", 5).error).toBe(true);
  });
});

describe("tagHeadingParagraphs + Word heading styles", () => {
  it("tags a lone large bold paragraph as Heading 1 and a smaller one as Heading 2", () => {
    const mk = (text, size, bold) => ({ type: "paragraph", runs: [{ text, bold, size }], listItem: false });
    const blocks = [
      mk("Annual Report", 20, true),
      mk("Sales by region", 13, true),
      mk("The quick brown fox jumps over the lazy dog and keeps running on.", 11, false),
      mk("Another ordinary body paragraph of regular text at body size.", 11, false),
      mk("Yet another ordinary body paragraph of regular text at body size.", 11, false),
      mk("One more ordinary body paragraph of regular text at body size.", 11, false),
      mk("A very long bold lead-in that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on.", 18, true),
    ];
    sandbox.tagHeadingParagraphs(blocks);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[1].headingLevel).toBe(2);
    expect(blocks[2].headingLevel).toBeUndefined();
    expect(blocks[3].headingLevel).toBeUndefined();
    expect(blocks[4].headingLevel).toBeUndefined();
    expect(blocks[5].headingLevel).toBeUndefined();
    expect(blocks[6].headingLevel).toBeUndefined();
  });
  it("buildMixedDocx emits styles.xml and pStyle references for tagged headings", async () => {
    const pageSize = { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72 };
    const blocks = [
      { type: "paragraph", runs: [{ text: "Annual Report", bold: true, size: 20 }], headingLevel: 1, _pageSize: pageSize },
      { type: "paragraph", runs: [{ text: "Body text here.", bold: false, size: 11 }], _pageSize: pageSize },
    ];
    const blob = await sandbox.buildMixedDocx(blocks, pageSize, {});
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const styles = await zip.file("word/styles.xml").async("string");
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="Heading2"');
    const documentXml = await zip.file("word/document.xml").async("string");
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    const contentTypes = await zip.file("[Content_Types].xml").async("string");
    expect(contentTypes).toContain("/word/styles.xml");
  });
});

describe("PDF to Excel one-sheet layout", () => {
  it("stacks two pages on one sheet with a shared column grid", async () => {
    const pages = await loadBlocks(await buildTwoPageRuledTablePdf());
    // Handler's one-sheet two-pass assembly (feed-forward shared bounds,
    // then rebuild each page against the final bounds), copied from
    // TOOLS.pdf2excel in js/tools/pdf-convert-tools.js.
    let sharedBounds = [];
    const layouts = pages.map((blocks) => {
      const layout = sandbox.buildPageLayout(blocks, blocks._pageWidthPt, blocks._pageHeightPt, sharedBounds.length ? sharedBounds : null);
      sharedBounds = layout.colBoundsPt.slice();
      return layout;
    });
    expect(sharedBounds.length).toBeGreaterThanOrEqual(4);
    const pageData = pages.map((blocks, i) => ({
      kind: "layout", i: i + 1, pageWidthPt: blocks._pageWidthPt, pageHeightPt: blocks._pageHeightPt,
      pageGeometry: null, blocks, visuals: blocks._visuals,
    }));
    const allRows = [];
    let startRow = 0;
    pageData.forEach((pd, idx) => {
      if (idx > 0) { allRows.push([]); startRow++; }
      const built = sandbox.pdfExcelPageToSheet(pd, startRow, sharedBounds);
      built.rows.forEach((r) => allRows.push(r));
      startRow += built.rows.length;
    });
    const ws = XLSX.utils.aoa_to_sheet(allRows);
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const findRow = (needle) => aoa.find((r) => r.some((c) => String(c).includes(needle)));
    const alphaRow = findRow("Alpha Person");
    const gammaRow = findRow("Gamma Person");
    expect(alphaRow).toBeDefined();
    expect(gammaRow).toBeDefined();
    // Both pages' tables land in the same columns on the shared grid.
    expect(alphaRow.indexOf("Alpha Person")).toBe(gammaRow.indexOf("Gamma Person"));
    expect(alphaRow.indexOf("9876543210")).toBe(gammaRow.indexOf("9998887770"));
    // One blank separator row sits between the two pages' tables.
    const alphaIdx = aoa.indexOf(alphaRow);
    const gammaIdx = aoa.indexOf(gammaRow);
    expect(gammaIdx - alphaIdx).toBeGreaterThan(2);
    expect(layouts.length).toBe(2);
  });

  it("pdfExcelColsFromBounds converts points to Excel column widths", () => {
    const cols = sandbox.pdfExcelColsFromBounds([0, 100, 300]);
    expect(cols).toHaveLength(2);
    expect(cols[0].wch).toBeGreaterThan(10);
    expect(cols[1].wch).toBeGreaterThan(cols[0].wch);
  });
});

describe("Excel to PDF styles via raw OOXML enrichment", () => {
  async function buildStyledWorkbookBytes() {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Name", "Amt"], ["Alpha", 1234.5], ["ShouldNotAppear", 1]]);
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const zip = await JSZip.loadAsync(buf);
    let styles = await zip.file("xl/styles.xml").async("string");
    styles = styles.replace(/<fonts count="\d+">/, '<fonts count="2">');
    styles = styles.replace("</fonts>", '<font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>');
    styles = styles.replace(/<fills count="\d+">/, '<fills count="3">');
    styles = styles.replace("</fills>", '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>');
    styles = styles.replace(/<borders count="\d+">/, '<borders count="2">');
    styles = styles.replace("</borders>", '<border><left/><right/><top/><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>');
    styles = styles.replace(/<cellXfs count="\d+">/, '<cellXfs count="2">');
    styles = styles.replace("</cellXfs>", '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs>');
    zip.file("xl/styles.xml", styles);
    let sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    sheet = sheet.replace('<c r="A1"', '<c r="A1" s="1"');
    sheet = sheet.replace("</sheetData>", '</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToPage="1"/>');
    zip.file("xl/worksheets/sheet1.xml", sheet);
    let wbxml = await zip.file("xl/workbook.xml").async("string");
    wbxml = wbxml.replace("</workbook>", '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$B$2</definedName></definedNames></workbook>');
    zip.file("xl/workbook.xml", wbxml);
    return zip.generateAsync({ type: "array" });
  }

  it("resolves fonts, fills, borders, alignment, page setup and print area from the package", async () => {
    const bytes = await buildStyledWorkbookBytes();
    const wb = XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: true });
    await sandbox.excelEnrichWorkbook(bytes.slice(0), wb);
    const cell = wb.Sheets.Data["A1"];
    expect(cell.s.font.bold).toBe(true);
    expect(cell.s.font.sz).toBe(14);
    expect(cell.s.font.color.rgb).toBe("FF0000");
    expect(cell.s.fill.patternType).toBe("solid");
    expect(cell.s.fill.fgColor.rgb).toBe("FFFF00");
    expect(cell.s.border.bottom.style).toBe("thin");
    expect(cell.s.alignment.horizontal).toBe("center");
    const opts = sandbox.excelPdfPrintOptions(wb, "Data");
    expect(opts.pageWidth).toBe(842);
    expect(opts.pageHeight).toBe(595);
    expect(opts.printRange).not.toBeNull();
    expect(opts.printRange.s.r).toBe(0);
    expect(opts.printRange.e.r).toBe(1);
  });

  it("renders a landscape page honouring the print area (row 3 excluded)", async () => {
    const bytes = await buildStyledWorkbookBytes();
    const wb = XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: true });
    await sandbox.excelEnrichWorkbook(bytes.slice(0), wb);
    const outBytes = await sandbox.buildExcelWorkbookPdfBytes(wb, null);
    const doc = await PDFDocument.load(outBytes);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeGreaterThan(page.getHeight());
    const pdoc = await pdfjsLib.getDocument({ data: outBytes }).promise;
    const text = (await (await pdoc.getPage(1)).getTextContent()).items.map((it) => it.str).join(" ");
    expect(text).toContain("Name");
    expect(text).not.toContain("ShouldNotAppear");
  });
});

describe("Word to PDF hyperlinks and unsupported-feature detection", () => {
  async function buildDocxBytes({ hyperlink, anchor, vMerge, footnotes }) {
    const zip = new JSZip();
    let body = `<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r>`;
    if (hyperlink) body += `<w:hyperlink r:id="rId5"><w:r><w:t xml:space="preserve">Visit site</w:t></w:r></w:hyperlink>`;
    body += `<w:r><w:t xml:space="preserve"> end.</w:t></w:r></w:p>`;
    if (anchor) body += `<w:p><w:r><w:drawing><wp:anchor><a:graphic/></wp:anchor></w:drawing></w:r></w:p>`;
    if (vMerge) body += `<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const docXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${body}</w:body></w:document>`;
    zip.file("word/document.xml", docXml);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/page" TargetMode="External"/></Relationships>`);
    if (footnotes) zip.file("word/footnotes.xml", `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
    return zip.generateAsync({ type: "arraybuffer" });
  }

  it("extracts external hyperlink spans and tags matching tokens", async () => {
    const bytes = await buildDocxBytes({ hyperlink: true });
    const zip = await JSZip.loadAsync(bytes);
    const docXml = await zip.file("word/document.xml").async("string");
    const relsXml = await zip.file("word/_rels/document.xml.rels").async("string");
    const spans = sandbox.docxHyperlinkSpans(docXml, relsXml);
    expect(spans).toEqual([{ text: "Visit site", url: "https://example.com/page" }]);
    const sections = [{ blocks: [{ type: "paragraph", tokens: [
      { kind: "text", text: "Hello " }, { kind: "text", text: "Visit site" }, { kind: "text", text: " end." },
    ] }] }];
    const tagged = sandbox.docxTagHyperlinkTokens(sections, spans);
    expect(tagged).toBe(1);
    expect(sections[0].blocks[0].tokens[1].linkUrl).toBe("https://example.com/page");
    expect(sections[0].blocks[0].tokens[0].linkUrl).toBeUndefined();
  });

  it("detects floating shapes, vMerge and footnotes", async () => {
    const bytes = await buildDocxBytes({ anchor: true, vMerge: true, footnotes: true });
    const found = await sandbox.docxDetectUnsupportedFeatures(bytes);
    expect(found).toEqual(["floatingShapes", "vMerge", "footnotes"]);
    const clean = await sandbox.docxDetectUnsupportedFeatures(await buildDocxBytes({}));
    expect(clean).toEqual([]);
  });

  it("wordAddLinkAnnotations writes a real /Link annotation with the URL", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    sandbox.wordAddLinkAnnotations(doc, page, [{ x: 10, y: 700, width: 80, height: 12, url: "https://example.com/page" }]);
    const saved = await doc.save();
    const reloaded = await PDFDocument.load(saved);
    const reloadedPage = reloaded.getPage(0);
    const annots = reloadedPage.node.lookup(PDFName.of("Annots"));
    expect(annots.size()).toBe(1);
    const annot = annots.lookup(0);
    const action = annot.lookup(PDFName.of("A"));
    expect(action.lookup(PDFName.of("URI")).decodeText()).toBe("https://example.com/page");
    expect(annot.lookup(PDFName.of("Subtype")).toString()).toBe("/Link");
  });
});

describe("PDF to PowerPoint mixed page sizes", () => {
  it("pptxDeckPageSize picks the modal size and counts scaled pages", () => {
    const size = sandbox.pptxDeckPageSize([
      { pageWidthPt: 612, pageHeightPt: 792 },
      { pageWidthPt: 612, pageHeightPt: 792 },
      { pageWidthPt: 842, pageHeightPt: 595 },
    ]);
    expect(size.slideWidthPt).toBe(612);
    expect(size.slideHeightPt).toBe(792);
    expect(size.scaledCount).toBe(1);
  });

  it("letterboxes an outlier page inside the modal slide bounds", async () => {
    const para = (text, size) => ({ type: "paragraph", runs: [{ text, size, bold: false }], _y: 700 });
    const pages = [
      { pageWidthPt: 612, pageHeightPt: 792, blocks: [para("Portrait title", 20)] },
      { pageWidthPt: 842, pageHeightPt: 595, blocks: [para("Landscape title that is fairly long", 20)] },
    ];
    const blob = await sandbox.buildEditablePptx(pages, "Mixed");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const pres = await zip.file("ppt/presentation.xml").async("string");
    // Modal size: first page (portrait Letter-ish 612x792).
    expect(pres).toContain('cx="7772400"');
    expect(pres).toContain('cy="10058400"');
    const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
    const offRe = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/g;
    let m, checked = 0;
    while ((m = offRe.exec(slide2))) {
      const [, x, y, cx, cy] = m.map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + cx).toBeLessThanOrEqual(7772400);
      expect(y + cy).toBeLessThanOrEqual(10058400);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("shared XObject images (parity follow-up)", () => {
  it("extractPageVisuals finds the same embedded image on every page", async () => {
    // 1x1 transparent PNG, drawn large on two pages from ONE embed: pdf-lib
    // writes a single shared XObject, which pdf.js serves as a global (g_*)
    // object from page.commonObjs. The old page.objs.get() path resolved it
    // only on the first page processed.
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(Buffer.from(pngBase64, "base64"));
    for (let p = 0; p < 2; p++) {
      const page = doc.addPage([612, 792]);
      page.drawImage(png, { x: 100, y: 500, width: 200, height: 200 });
    }
    const bytes = await doc.save();
    const pdoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    expect(pdoc.numPages).toBe(2);
    for (let i = 1; i <= 2; i++) {
      const visuals = await sandbox.extractPageVisuals(pdoc, i);
      expect(visuals.images.length).toBeGreaterThanOrEqual(1);
      expect(visuals.images[0].raw).toBeTruthy();
    }
  });
});
