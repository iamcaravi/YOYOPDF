import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { PDFDocument, rgb } from "pdf-lib";
import JSZip from "jszip";

// js/core/pptx-export.js and js/core/doc-export-builders.js are classic
// (non-module) browser scripts, loaded into a vm sandbox exactly as
// tests/pdf-to-excel.test.js does - the shipped source is exercised
// unmodified. ensureJSZip is stubbed because JSZip is injected directly
// (in the browser it lazy-loads from CDN via js/core/lazy-loaders.js).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sandbox;
beforeAll(() => {
  sandbox = vm.createContext({
    console, pdfjsLib, XLSX: null, JSZip, setTimeout, clearTimeout,
    ensureJSZip: async () => {},
  });
  vm.runInContext(readFileSync(resolve(ROOT, "js/core/doc-export-builders.js"), "utf8"), sandbox, { filename: "doc-export-builders.js" });
  vm.runInContext(readFileSync(resolve(ROOT, "js/core/pptx-export.js"), "utf8"), sandbox, { filename: "pptx-export.js" });
});

async function unzipPptx(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const files = {};
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    // Media parts are binary; XML parts are text. Reading a binary
    // part as a string corrupts it under JSZip's UTF-8 decoding.
    files[name] = /\.(png|jpe?g)$/i.test(name)
      ? await entry.async("uint8array")
      : await entry.async("string");
  }
  return { zip, files };
}

// Minimal balanced-tag check over the XML parts PowerPoint is strictest
// about: every opened element must close in the right order. This is a
// proxy, not a schema validator - it catches the unterminated/misnested
// markup that makes PowerPoint offer to "repair" (or reject) a deck.
function assertXmlBalanced(xml, part) {
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, , selfClosing] = m;
    if (name.startsWith("?xml") || name.startsWith("!")) continue;
    if (closing) {
      expect(stack.pop(), `${part}: unexpected </${name}>`).toBe(name);
    } else if (!selfClosing && !m[3].trimEnd().endsWith("/")) {
      // A trailing "/" before ">" (e.g. <p:nvPr/>) is swallowed by the
      // attribute group above, so detect self-closing from it too.
      stack.push(name);
    }
  }
  expect(stack, `${part}: unclosed tags ${stack.join(",")}`).toEqual([]);
}

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("PDF to PowerPoint: editable builder (synthetic document model)", () => {
  it("turns paragraphs into editable textboxes preserving size, bold and colour", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [
        { type: "paragraph", _y: 800, xLeft: 40, xRight: 400, align: "left",
          runs: [{ text: "Quarterly Report", bold: true, size: 20, color: [255, 0, 0], fontFamily: "Arial" }] },
        { type: "paragraph", _y: 760, xLeft: 40, xRight: 500,
          runs: [{ text: "Sales grew ", size: 12 }, { text: "fast", bold: true, italic: true, size: 12 }] },
      ],
    }];
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Report"));
    const slide = files["ppt/slides/slide1.xml"];
    expect(slide).toContain("<a:t>Quarterly Report</a:t>");
    expect(slide).toContain("<a:t>Sales grew </a:t>");
    expect(slide).toContain("<a:t>fast</a:t>");
    expect(slide).toContain('sz="2000"');
    expect(slide).toContain('b="1"');
    expect(slide).toContain('i="1"');
    expect(slide).toContain('<a:srgbClr val="FF0000"/>');
    // Real textboxes, not pictures: no <p:pic> on a text-only slide.
    expect(slide).not.toContain("<p:pic>");
    expect(slide).toContain("<p:sp>");
    assertXmlBalanced(slide, "slide1.xml");
    // Slide sized to the page itself (A4-ish 595x842pt -> EMU).
    expect(files["ppt/presentation.xml"]).toContain(`<p:sldSz cx="${595 * 12700}" cy="${842 * 12700}"/>`);
  });

  it("turns a gridtable into a real editable DrawingML table, including a spanned header cell", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [{
        type: "gridtable", nRows: 2, nCols: 2, bordered: true, _y: 700,
        colWidthsPt: [100, 100],
        colBounds: [40, 140, 240],
        rowBounds: [700, 676, 652],
        cells: [
          { r0: 0, c0: 0, rowSpan: 1, colSpan: 2, text: "Summary", runs: [{ text: "Summary", bold: true, size: 11 }] },
          { r0: 1, c0: 0, rowSpan: 1, colSpan: 1, text: "Alpha", runs: [{ text: "Alpha", size: 11 }] },
          { r0: 1, c0: 1, rowSpan: 1, colSpan: 1, text: "42", runs: [{ text: "42", size: 11 }] },
        ],
      }],
    }];
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Table"));
    const slide = files["ppt/slides/slide1.xml"];
    expect(slide).toContain("<a:tbl>");
    expect(slide).toContain("<a:t>Summary</a:t>");
    expect(slide).toContain("<a:t>Alpha</a:t>");
    expect(slide).toContain("<a:t>42</a:t>");
    // Spanned header: one master cell with gridSpan=2, one hMerge placeholder.
    expect(slide).toContain('gridSpan="2"');
    expect(slide).toContain('hMerge="1"');
    assertXmlBalanced(slide, "slide1.xml");
  });

  it("places embedded images as real pictures with media parts and layout relationship", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [
        { type: "paragraph", _y: 800, xLeft: 40, xRight: 400, runs: [{ text: "Logo page", size: 12 }] },
        { type: "image", pngBase64: TINY_PNG_B64, width: 10, height: 10, widthPt: 60, heightPt: 60,
          placement: "anchored", xPt: 40, yFromTopPt: 60, _y: 700 },
      ],
    }];
    const { zip, files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Images"));
    expect(Object.keys(zip.files)).toContain("ppt/media/image1.png");
    expect(files["[Content_Types].xml"]).toContain('Extension="png"');
    expect(files["ppt/slides/slide1.xml"]).toContain("<p:pic>");
    expect(files["ppt/slides/_rels/slide1.xml.rels"]).toContain("slideLayout");
    expect(files["ppt/slides/_rels/slide1.xml.rels"]).toContain("image1.png");
    assertXmlBalanced(files["ppt/slides/slide1.xml"], "slide1.xml");
  });

  it("renders a full-page image block as a full-slide picture (scanned-page fallback)", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [{ type: "image", pngBase64: TINY_PNG_B64, width: 595, height: 842,
        widthPt: 595, heightPt: 842, placement: "anchored", xPt: 0, yFromTopPt: 0, _y: 842 }],
    }];
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Scanned"));
    const slide = files["ppt/slides/slide1.xml"];
    expect(slide).toContain("<p:pic>");
    expect(slide).not.toContain("<a:t>");
    expect(slide).toContain(`<a:off x="0" y="0"/><a:ext cx="${595 * 12700}" cy="${842 * 12700}"/>`);
    assertXmlBalanced(slide, "slide1.xml");
  });

  it("preserves Hindi (Devanagari) text intact in slide XML", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [{ type: "paragraph", _y: 800, xLeft: 40, xRight: 500,
        runs: [{ text: "कानपुर में नया विकास कार्य शुरू", bold: true, size: 18 }] }],
    }];
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Hindi"));
    expect(files["ppt/slides/slide1.xml"]).toContain("<a:t>कानपुर में नया विकास कार्य शुरू</a:t>");
    assertXmlBalanced(files["ppt/slides/slide1.xml"], "slide1.xml");
  });

  it("escapes XML-special text and strips control characters instead of producing invalid XML", async () => {
    const pages = [{
      pageWidthPt: 595, pageHeightPt: 842,
      blocks: [{ type: "paragraph", _y: 800, xLeft: 40, xRight: 400,
        runs: [{ text: "Tom & Jerry <b> \"quoted\" \u0001 end", size: 12 }] }],
    }];
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Escaping"));
    const slide = files["ppt/slides/slide1.xml"];
    expect(slide).toContain("Tom &amp; Jerry &lt;b&gt; &quot;quoted&quot;");
    expect(slide).not.toContain("\u0001");
    assertXmlBalanced(slide, "slide1.xml");
  });
});

describe("PDF to PowerPoint: end-to-end from a real PDF", () => {
  async function extractPages(pdfBytes) {
    const pdoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    const pages = [];
    for (let i = 1; i <= pdoc.numPages; i++) {
      const pdfPage = await pdoc.getPage(i);
      const visuals = await sandbox.extractPageVisuals(pdoc, i);
      const blocks = await sandbox.extractPageBlocks(pdoc, i, visuals);
      pages.push({
        pageWidthPt: pdfPage.view[2] - pdfPage.view[0],
        pageHeightPt: pdfPage.view[3] - pdfPage.view[1],
        blocks,
      });
    }
    return pages;
  }

  it("converts a heading + ruled table PDF into editable slides with the table intact", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const boldFont = await doc.embedFont("Helvetica-Bold");
    const page = doc.addPage([595, 842]);
    page.drawText("Monthly Sales", { x: 40, y: 790, size: 20, font: boldFont });
    page.drawText("Figures for the quarter.", { x: 40, y: 760, size: 11, font });
    // Ruled 3x2 grid, thin filled rectangles (same pattern as pdf-to-excel tests).
    const x0 = 40, yTop = 720, colWidths = [80, 160, 100], rowHeight = 24;
    const colXs = [x0];
    colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
    for (let r = 0; r <= 2; r++) {
      const y = yTop - r * rowHeight;
      page.drawRectangle({ x: x0, y: y - 0.36, width: 340, height: 0.72, color: rgb(0, 0, 0) });
    }
    for (let c = 0; c <= 3; c++) {
      page.drawRectangle({ x: colXs[c] - 0.36, y: yTop - 48, width: 0.72, height: 48, color: rgb(0, 0, 0) });
    }
    const rows = [["Item", "Qty", "Price"], ["Apples", "10", "500"]];
    rows.forEach((row, r) => row.forEach((text, c) => {
      page.drawText(text, { x: colXs[c] + 4, y: yTop - r * rowHeight - 16, size: 10, font });
    }));
    const pdfBytes = new Uint8Array(await doc.save());

    const pages = await extractPages(pdfBytes);
    const { files } = await unzipPptx(await sandbox.buildEditablePptx(pages, "Sales"));
    const slide = files["ppt/slides/slide1.xml"];
    expect(slide).toContain("<a:t>Monthly Sales</a:t>");
    expect(slide).toContain("<a:t>Figures for the quarter.</a:t>");
    expect(slide).toContain("<a:tbl>");
    expect(slide).toContain("<a:t>Item</a:t>");
    expect(slide).toContain("<a:t>Apples</a:t>");
    expect(slide).toContain("<a:t>500</a:t>");
    assertXmlBalanced(slide, "slide1.xml");
  });

  it("keeps the legacy image-only builder working for callers that still need it", async () => {
    const blob = await sandbox.buildPptxFromPageImages(
      // Uint8Array here stands in for the canvas Blob the browser
      // passes; JSZip accepts both and the zip structure is identical.
      [{ blob: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), widthPx: 100, heightPx: 100 }],
      "Legacy",
    );
    const { zip, files } = await unzipPptx(blob);
    expect(Object.keys(zip.files)).toContain("ppt/media/image1.jpeg");
    expect(files["ppt/slides/slide1.xml"]).toContain("<p:pic>");
    assertXmlBalanced(files["ppt/slides/slide1.xml"], "slide1.xml");
  });
});
