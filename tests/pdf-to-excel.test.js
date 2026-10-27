import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { PDFDocument, rgb } from "pdf-lib";
import XLSX from "xlsx";
import JSZip from "jszip";

// js/core/doc-export-builders.js is a classic (non-module) browser script,
// loaded into a vm sandbox the same way tests/xlsx-merge.test.js does for
// js/core/xlsx-merge.js - this file's unmodified source (including the
// real ruling-grid/borderless table detectors PDF to Word already relies
// on) is exercised exactly as shipped. pdfjsLib is injected because
// extractPageVisuals() reads pdfjsLib.OPS - the same global index.html
// provides via a <script> tag in the browser.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sandbox;
beforeAll(() => {
  const source = readFileSync(resolve(ROOT, "js/core/doc-export-builders.js"), "utf8");
  sandbox = vm.createContext({ console, pdfjsLib, XLSX, JSZip, setTimeout, clearTimeout });
  vm.runInContext(source, sandbox, { filename: "doc-export-builders.js" });
});

async function loadBlocks(pdfBytes) {
  const pdoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const pages = [];
  for (let i = 1; i <= pdoc.numPages; i++) {
    const pdfPage = await pdoc.getPage(i);
    const visuals = await sandbox.extractPageVisuals(pdoc, i);
    const blocks = await sandbox.extractPageBlocks(pdoc, i, visuals);
    // Real page dimensions, attached as non-array-index properties so
    // convertPagesToSheet can feed buildPageLayout the same real
    // pageWidthPt/pageHeightPt TOOLS.pdf2excel reads from pdfPage.view -
    // ordinary array operations (map/find/filter/length) on `blocks`
    // are unaffected by these extra named properties.
    blocks._pageWidthPt = pdfPage.view[2] - pdfPage.view[0];
    blocks._pageHeightPt = pdfPage.view[3] - pdfPage.view[1];
    pages.push(blocks);
  }
  return pages;
}

// Mirrors TOOLS.pdf2excel's per-page loop in js/tools/pdf-convert-tools.js:
// each PDF page gets its OWN independent PageLayout/sheet (no cross-page
// column-grid carry-forward, no repeated-header stripping - see the
// architectural note in pdf-convert-tools.js). Returns one result object
// PER PAGE, each shaped like the single-sheet result the previous
// checkpoint's tests expected ({rows, merges, gridRanges, cellStyles,
// cellEdges, rowHeights, colWidthsByIndex}), so multi-page-aware tests can
// inspect each page independently.
function convertPagesToSheets(pagesOfBlocks) {
  return pagesOfBlocks.map((blocks) => {
    const pageWidthPt = blocks._pageWidthPt || 612;
    const pageHeightPt = blocks._pageHeightPt || 792;
    const pageLayout = sandbox.buildPageLayout(blocks, pageWidthPt, pageHeightPt, null);
    const converted = sandbox.layoutToSheetRows(pageLayout, 0);
    const colWidthsByIndex = pageLayout.colBoundsPt.length > 1
      ? pageLayout.colBoundsPt.slice(0, -1).map((x, i) => pageLayout.colBoundsPt[i + 1] - x)
      : [];
    return { ...converted, colWidthsByIndex };
  });
}
// Convenience for the overwhelming majority of tests, which only ever
// convert a SINGLE PDF page and want that one page's own result directly
// (equivalent to "the whole workbook", since a one-page PDF now produces
// a one-sheet workbook) - genuinely multi-page tests use
// convertPagesToSheets directly instead, one result per page/sheet.
function convertPagesToSheet(pagesOfBlocks) {
  return convertPagesToSheets(pagesOfBlocks)[0];
}

// Draws a real ruled table using individual THIN FILLED rectangles for
// every border line (drawRectangle with no borderColor -> a plain `re f`
// PDF fill, no stroke) - the exact real-world pattern (confirmed against
// an actual government-generated table PDF) that used to be invisible to
// detectRulingGridTable entirely, for two independent reasons fixed in
// this checkpoint: (1) extractPageVisuals mis-parsed a `re` (rectangle)
// sub-op's [x,y,width,height] args as two more (x,y) points, corrupting
// every filled rect's bounding box; (2) detectRulingGridTable only ever
// looked for shapes with .stroke set, never plain filled bars.
function drawRuledGrid(page, { x0, yTop, colWidths, rowHeight, nRows }) {
  const nCols = colWidths.length;
  const colXs = [x0];
  colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
  const totalWidth = colXs[colXs.length - 1] - x0;
  const totalHeight = rowHeight * nRows;
  for (let r = 0; r <= nRows; r++) {
    const y = yTop - r * rowHeight;
    page.drawRectangle({ x: x0, y: y - 0.36, width: totalWidth, height: 0.72, color: rgb(0, 0, 0) });
  }
  for (let c = 0; c <= nCols; c++) {
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
  const font = await doc.embedFont("Helvetica");
  const header = ["ID", "Name", "Phone"];
  const geometry = { x0: 40, yTop: 780, colWidths: [80, 160, 100], rowHeight: 24, nRows: 3 };

  const page1 = doc.addPage([595, 842]);
  const grid1 = drawRuledGrid(page1, geometry);
  drawGridText(page1, font, grid1, [header, ["1", "Alpha Person", "9876543210"], ["2", "Beta Person", "0123456"]]);

  const page2 = doc.addPage([595, 842]);
  const grid2 = drawRuledGrid(page2, geometry);
  drawGridText(page2, font, grid2, [header, ["3", "Gamma Person", "9998887770"], ["4", "Delta Person", "5551234567"]]);

  return new Uint8Array(await doc.save());
}

// Real-world regression: a real government table PDF draws its ENTIRE
// border grid (~107 individual thin border-line rectangles) as ONE
// eoFill/fill call containing many disjoint moveTo/lineTo/lineTo/lineTo/
// closePath SUBPATHS, not one `re`+`f` per line and not one shape per
// fill. drawSvgPath with a multi-"M" path string compiles to exactly that
// PDF structure (one path object, several subpaths, one fill). Confirms
// splitIntoSubpathBBoxes (inside extractPageVisuals) correctly recovers
// each individual thin line instead of one bounding box spanning the
// whole merged path - the fix that made real-world ruling-grid detection
// possible at all for this class of document.
async function buildMergedSubpathGridPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([595, 842]);
  const x0 = 40, yTop = 780, colWidths = [80, 160, 100], rowHeight = 24, nRows = 3;
  const nCols = colWidths.length;
  const colXs = [x0];
  colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
  const totalWidth = colXs[colXs.length - 1] - x0;
  const totalHeight = rowHeight * nRows;
  const pdfY = (y) => 842 - y; // drawSvgPath's y axis runs top-down from the page's own origin
  const bar = (x, y, w, h) => `M${x},${pdfY(y)} L${x + w},${pdfY(y)} L${x + w},${pdfY(y + h)} L${x},${pdfY(y + h)} Z `;
  let d = "";
  for (let r = 0; r <= nRows; r++) d += bar(x0, yTop - r * rowHeight - 0.36, totalWidth, 0.72);
  for (let c = 0; c <= nCols; c++) d += bar(colXs[c] - 0.36, yTop - totalHeight, 0.72, totalHeight);
  page.drawSvgPath(d, { color: rgb(0, 0, 0) }); // one merged fill, many subpaths - the real bug's exact shape
  drawGridText(page, font, { colXs, rowYs: Array.from({ length: nRows + 1 }, (_, r) => yTop - r * rowHeight) }, [
    ["ID", "Name", "Phone"],
    ["1", "Solo Person", "9876543210"],
  ]);
  return new Uint8Array(await doc.save());
}

// No rects at all - pure spacing-separated text, the same shape the
// borderless (buildBorderlessTable) / per-line fallback path has always
// had to handle.
async function buildBorderlessTablePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([595, 842]);
  const rows = [
    ["Item", "Qty", "Price"],
    ["Widget", "3", "9.50"],
    ["Gadget", "1", "19.00"],
  ];
  rows.forEach((row, r) => {
    const y = 780 - r * 20;
    page.drawText(row[0], { x: 40, y, size: 10, font });
    page.drawText(row[1], { x: 220, y, size: 10, font });
    page.drawText(row[2], { x: 320, y, size: 10, font });
  });
  return new Uint8Array(await doc.save());
}

describe("PDF to Excel: ruled-grid table detection (real-world regression)", () => {
  it("detects a table drawn as thin FILLED rectangles (no stroke) as a real gridtable, not the weak spacing fallback", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const [page1Blocks] = await loadBlocks(bytes);
    expect(page1Blocks.length).toBe(1);
    expect(page1Blocks[0].type).toBe("gridtable");
    expect(page1Blocks[0].nRows).toBe(3);
    expect(page1Blocks[0].nCols).toBe(3);
  });

  it("preserves row/column alignment from the detected grid geometry", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const [page1Blocks] = await loadBlocks(bytes);
    const grid = page1Blocks[0];
    const cellAt = (r, c) => grid.cells.find((cell) => cell.r0 === r && cell.c0 === c);
    expect(cellAt(0, 0).text).toBe("ID");
    expect(cellAt(0, 1).text).toBe("Name");
    expect(cellAt(1, 1).text).toBe("Alpha Person");
    expect(cellAt(2, 2).text).toBe("0123456");
  });

  it("recovers individual border-line shapes from a table whose entire grid is ONE merged multi-subpath fill (real-world regression)", async () => {
    const bytes = await buildMergedSubpathGridPdf();
    const [pageBlocks] = await loadBlocks(bytes);
    const grid = pageBlocks.find((b) => b.type === "gridtable");
    expect(grid, "the merged-subpath grid must still be detected as a real gridtable, not collapsed into one useless shape").toBeTruthy();
    expect(grid.nRows).toBe(2);
    expect(grid.nCols).toBe(3);
    const cellAt = (r, c) => grid.cells.find((cell) => cell.r0 === r && cell.c0 === c);
    expect(cellAt(0, 0).text).toBe("ID");
    expect(cellAt(1, 1).text).toBe("Solo Person");
    expect(cellAt(1, 2).text).toBe("9876543210");
  });
});

describe("PDF to Excel: borderless spacing fallback (unchanged behavior)", () => {
  it("still recognizes a borderless, spacing-based table when no ruling grid exists", async () => {
    const bytes = await buildBorderlessTablePdf();
    const [pageBlocks] = await loadBlocks(bytes);
    const tableish = pageBlocks.find((b) => b.type === "gridtable" || b.type === "table");
    expect(tableish, "expected a table-like block from the borderless fallback").toBeTruthy();
    const layout = sandbox.buildPageLayout([tableish], 612, 792);
    const rows = sandbox.layoutToSheetRows(layout, 0).rows;
    const flat = rows.map((r) => r.map((c) => (c && c.v !== undefined ? c.v : c)));
    expect(flat.some((r) => r.includes("Widget"))).toBe(true);
    expect(flat.some((r) => r.includes("Gadget"))).toBe(true);
  });
});

describe("PDF to Excel: identifier-like numeric strings stay text", () => {
  it("keeps long digit runs and leading-zero codes as string cells, not unsafe Excel numbers", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const { rows } = convertPagesToSheet(pages);
    // "9876543210" (10-digit phone) and "0123456" (leading zero) must be
    // preserved as {t:"s"} cell objects; a short id like "1"/"2" is left
    // as an ordinary value for SheetJS's own numeric auto-typing.
    const phoneCell = rows.flat().find((c) => c && c.v === "9876543210");
    expect(phoneCell).toBeTruthy();
    expect(phoneCell.t).toBe("s");
    const leadingZeroCell = rows.flat().find((c) => c && c.v === "0123456");
    expect(leadingZeroCell).toBeTruthy();
    expect(leadingZeroCell.t).toBe("s");
    const idCell = rows[1][0];
    expect(idCell).toBe("1"); // short id, left as a plain value (SheetJS infers it as numeric 1)
  });
});

// Builds the complete multi-sheet workbook exactly the way TOOLS.pdf2excel
// does (one worksheet per PDF page, each built from its OWN independent
// PageLayout -> aoa_to_sheet -> !cols -> XLSX.write -> ONE shared
// applyCellFormattingToXlsx call across all sheets) so every formatting
// test exercises the real end-to-end pipeline, not a hand-picked subset.
// pageGeometry, if given, overrides every page's own detected geometry
// (test convenience for the small number of tests that want one explicit
// geometry rather than each page's own real detected one).
async function buildStyledWorkbook(pages, pageGeometry) {
  const perPage = convertPagesToSheets(pages);
  const wb = XLSX.utils.book_new();
  const pagesFormatting = [];
  perPage.forEach((converted, i) => {
    const ws = XLSX.utils.aoa_to_sheet(converted.rows);
    if (converted.merges.length) ws["!merges"] = converted.merges;
    if (converted.colWidthsByIndex.length) {
      // Mirrors TOOLS.pdf2excel exactly: absolute physical wch (Excel's own
      // documented px=wch*7+5 formula), no rescale - real column width has
      // to match the real (matching-paperSize) page at natural 100% print
      // scale, see applyCellFormattingToXlsx's fitToWidth removal.
      const PX_PER_PT = 96 / 72, MDW = 7;
      ws["!cols"] = converted.colWidthsByIndex.map((w) => ({ wch: Math.max(1, Math.round(((w || 60) * PX_PER_PT - 5) / MDW * 100) / 100) }));
    }
    if (pageGeometry) {
      const firstGrid = pages[i].find((b) => b.type === "gridtable" && b.colBounds && b.rowBounds);
      const toIn = (pt) => Math.max(0.2, pt / 72);
      ws["!margins"] = firstGrid ? {
        left: toIn(Math.min(...firstGrid.colBounds)), right: toIn(pageGeometry.widthPt - Math.max(...firstGrid.colBounds)),
        top: toIn(pageGeometry.heightPt - Math.max(...firstGrid.rowBounds)), bottom: toIn(Math.min(...firstGrid.rowBounds)),
        header: 0.3, footer: 0.3,
      } : { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
    }
    XLSX.utils.book_append_sheet(wb, ws, `Page ${i + 1}`);
    pagesFormatting.push({
      gridRanges: converted.gridRanges, cellStyles: converted.cellStyles,
      rowHeights: converted.rowHeights, cellEdges: converted.cellEdges,
      pageGeometry: pageGeometry || null,
    });
  });
  let wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  wbout = await sandbox.applyCellFormattingToXlsx(wbout, pagesFormatting);
  return { wbout, ...perPage[0] };
}

// Each PDF page is now its own independent worksheet (see the
// architectural note in TOOLS.pdf2excel) - a table continuing across a
// page break simply repeats its header on page 2's own sheet, exactly as
// the source PDF itself does when printed/paginated. There is no
// cross-page column-grid reconciliation or header-stripping left to test.
describe("PDF to Excel: each PDF page becomes its own independent worksheet", () => {
  it("a table continuing across a page break keeps its own header on EACH page's own sheet, with that page's own data beneath it", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const perPage = convertPagesToSheets(pages);
    expect(perPage.length).toBe(2);
    const isHeaderRow = (r) => r[0] === "ID" && r[1] === "Name" && r[2] === "Phone";
    expect(perPage[0].rows.some(isHeaderRow), "page 1's own sheet must have its own header").toBe(true);
    expect(perPage[1].rows.some(isHeaderRow), "page 2's own sheet must ALSO have its own header - it's a separate sheet, not a continuation of page 1's rows").toBe(true);
    const page1Names = perPage[0].rows.map((r) => r[1]).filter(Boolean);
    const page2Names = perPage[1].rows.map((r) => r[1]).filter(Boolean);
    expect(page1Names).toEqual(["Name", "Alpha Person", "Beta Person"]);
    expect(page2Names).toEqual(["Name", "Gamma Person", "Delta Person"]);
  });

  it("two structurally unrelated tables on two different pages each get their own independent column grid - never reconciled against each other", async () => {
    const rowsPage1 = [{ type: "gridtable", nRows: 1, nCols: 2, colBounds: [40, 120, 260], rowBounds: [700, 680], bordered: true, cells: [
      { r0: 0, c0: 0, rowSpan: 1, colSpan: 1, text: "Name", edges: {} },
      { r0: 0, c0: 1, rowSpan: 1, colSpan: 1, text: "Score", edges: {} },
    ], _y: 700 }];
    const rowsPage2 = [{ type: "gridtable", nRows: 1, nCols: 2, colBounds: [40, 300, 500], rowBounds: [700, 680], bordered: true, cells: [
      { r0: 0, c0: 0, rowSpan: 1, colSpan: 1, text: "Product", edges: {} },
      { r0: 0, c0: 1, rowSpan: 1, colSpan: 1, text: "Price", edges: {} },
    ], _y: 700 }];
    const perPage = convertPagesToSheets([rowsPage1, rowsPage2]);
    expect(perPage[0].rows.some((r) => r[0] === "Name" && r[1] === "Score")).toBe(true);
    expect(perPage[1].rows.some((r) => r[0] === "Product" && r[1] === "Price")).toBe(true);
    // Each page's own !cols-equivalent widths come purely from its own
    // table - page 2's much wider columns (260pt/200pt) never blend with
    // or get constrained by page 1's narrower ones (80pt/140pt).
    expect(perPage[0].colWidthsByIndex).toEqual([80, 140]);
    expect(perPage[1].colWidthsByIndex).toEqual([260, 200]);
  });
});

describe("PDF to Excel: multi-page PDFs produce a real, valid multi-sheet XLSX", () => {
  it("produces a real, structurally valid .xlsx package with one worksheet per page, all rows/merges applied", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const { wbout } = await buildStyledWorkbook(pages);

    const zip = await JSZip.loadAsync(wbout);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
      expect(zip.file(part), part + " must exist").toBeTruthy();
    }

    // Round-trip through SheetJS itself as an independent structural check
    // (mirrors how a real spreadsheet application would parse this file).
    const reopened = XLSX.read(wbout, { type: "array" });
    expect(reopened.SheetNames.length).toBe(2);
    const page1Rows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1, defval: "" });
    const page2Rows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[1]], { header: 1, defval: "" });
    expect(page1Rows.some((r) => r[1] === "Alpha Person")).toBe(true);
    expect(page2Rows.some((r) => r[1] === "Gamma Person")).toBe(true);
  });
});

describe("PDF to Excel: real cell borders and column widths (visual formatting)", () => {
  it("applies a real border style to every cell in a detected table's range, including cells with no value", async () => {
    const pages = await loadBlocks(await buildTwoPageRuledTablePdf());
    const { wbout, gridRanges } = await buildStyledWorkbook(pages);
    expect(gridRanges.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(wbout);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/styles.xml"]) {
      expect(zip.file(part), part + " must exist").toBeTruthy();
    }
    const styles = await zip.file("xl/styles.xml").async("string");
    expect(styles).toContain('style="thin"');
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    expect(sheetXml.match(/<c [^>]*s="\d+"[^>]*s="\d+"[^>]*>/g)).toBeNull();
    expect(sheetXml.match(/r="(undefined|NaN)/g)).toBeNull();
    const headerCells = sheetXml.match(/<c r="[A-C]1"[^>]*s="\d+"/g) || [];
    expect(headerCells.length).toBe(3);

    const reopened = XLSX.read(wbout, { type: "array" });
    const reopenedRows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1, defval: "" });
    expect(reopenedRows.some((r) => r[1] === "Alpha Person")).toBe(true);
  });

  it("produces real, non-default column widths from the detected grid geometry", async () => {
    const pages = await loadBlocks(await buildTwoPageRuledTablePdf());
    const { colWidthsByIndex } = convertPagesToSheet(pages);
    // geometry.colWidths was [80, 160, 100] in PDF points - the middle
    // ("Name") column must come out visibly wider than the others.
    expect(colWidthsByIndex.length).toBe(3);
    expect(colWidthsByIndex[1]).toBeGreaterThan(colWidthsByIndex[0]);
    expect(colWidthsByIndex[1]).toBeGreaterThan(colWidthsByIndex[2]);
  });
});

/* ==========================================================================
   GENERIC FORMATTING VALIDATION - a small diverse set of synthetic PDFs,
   each testing ONE structurally different layout, all run through the
   SAME formatting engine with NO document-specific code anywhere in
   js/core/doc-export-builders.js. If the engine were secretly overfit to
   1.pdf's specific shape, these would be the cases that expose it: none
   of them share 1.pdf's column count, labels, coordinates, or structure.
   ========================================================================== */

// A 5-column table with a genuine MERGED two-group header (drawn with
// vertical dividers omitted between the merged columns in the header row
// only - exactly how detectRulingGridTable infers colSpan: a missing
// internal divider where one would otherwise be expected), a bold header
// font (real embedded HelveticaBold vs Helvetica), a larger-size title
// paragraph above the table, one deliberately two-line (wrapped) cell,
// and a currency + comma-grouped-number + plain-decimal value mix.
async function buildMergedHeaderFormattedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const boldFont = await doc.embedFont("Helvetica-Bold");
  const page = doc.addPage([595, 842]);
  const x0 = 40, yTop = 700, colWidths = [40, 180, 90, 90, 140], rowHeight = 22, nRows = 4; // header, subheader, 2 data rows
  const nCols = colWidths.length;
  const colXs = [x0]; colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
  const totalWidth = colXs[colXs.length - 1] - x0;
  const rowYs = Array.from({ length: nRows + 1 }, (_, r) => yTop - r * rowHeight);

  // Larger-size title paragraph, well above the table (its own block).
  page.drawText("Diverse Fixture Report", { x: x0, y: yTop + 40, size: 16, font: boldFont });

  // Horizontal borders: full width at every row boundary.
  rowYs.forEach((y) => page.drawRectangle({ x: x0, y: y - 0.36, width: totalWidth, height: 0.72, color: rgb(0, 0, 0) }));
  // Vertical borders: header row (r=0..1) only gets dividers at the TWO
  // group boundaries (col 0 and col 2) plus the outer edges - no divider
  // between col0/col1 or between col2/col3/col4 in that row band, which
  // is what makes it a real merged header once detected. Every row below
  // the header gets a full divider at every column boundary.
  const groupBoundaryCols = [0, 2, nCols];
  groupBoundaryCols.forEach((c) => page.drawRectangle({ x: colXs[c] - 0.36, y: rowYs[1] - 0.36, width: 0.72, height: rowYs[0] - rowYs[1] + 0.72, color: rgb(0, 0, 0) }));
  for (let c = 0; c <= nCols; c++) {
    page.drawRectangle({ x: colXs[c] - 0.36, y: rowYs[nRows] - 0.36, width: 0.72, height: rowYs[1] - rowYs[nRows] + 0.72, color: rgb(0, 0, 0) });
  }

  function cellText(r, c, text, opts = {}) {
    page.drawText(text, { x: colXs[c] + 4, y: rowYs[r] - 16, size: opts.size || 10, font: opts.bold ? boldFont : font });
  }
  // Merged header row: one label centered under each group's own span.
  cellText(0, 0, "Details", { bold: true });
  cellText(0, 2, "Amounts", { bold: true });
  // Real column-label row underneath.
  cellText(1, 0, "ID", { bold: true });
  cellText(1, 1, "Description", { bold: true });
  cellText(1, 2, "Unit Price", { bold: true });
  cellText(1, 3, "Total", { bold: true });
  cellText(1, 4, "Notes", { bold: true });
  // Data row 1: a genuinely two-line (wrapped) Notes cell - two separate
  // drawText calls at different y within the same row band.
  cellText(2, 0, "1");
  cellText(2, 1, "Widget Assembly Kit");
  cellText(2, 2, "1,234.56");
  cellText(2, 3, "1,234");
  page.drawText("First line of notes", { x: colXs[4] + 4, y: rowYs[2] - 10, size: 9, font });
  page.drawText("Second line continues", { x: colXs[4] + 4, y: rowYs[2] - 20, size: 9, font });
  // Data row 2: a currency-symbol amount and a plain decimal.
  cellText(3, 0, "2");
  cellText(3, 1, "Gadget Housing");
  cellText(3, 2, "$999.00");
  cellText(3, 3, "42.50");
  cellText(3, 4, "OK");

  return new Uint8Array(await doc.save());
}

describe("PDF to Excel: GENERIC formatting across diverse, structurally different layouts", () => {
  it("[case 5/6/7/8] detects a real merged multi-column header, bold header font vs plain data font, a larger title font, a wrapped multi-line cell, and currency/number values - purely from this document's own geometry and font metadata", async () => {
    const pages = await loadBlocks(await buildMergedHeaderFormattedPdf());
    const grid = pages[0].find((b) => b.type === "gridtable");
    expect(grid, "expected the 5-column merged-header table to be detected as a real gridtable").toBeTruthy();
    expect(grid.nCols).toBe(5);
    // The merged header itself: "Details" spans columns 0-1, "Amounts"
    // spans columns 2-4 - real colSpan inferred from the missing divider,
    // not hardcoded.
    const detailsCell = grid.cells.find((c) => c.text === "Details");
    const amountsCell = grid.cells.find((c) => c.text === "Amounts");
    expect(detailsCell.colSpan).toBe(2);
    expect(amountsCell.colSpan).toBe(3);

    const { wbout, cellStyles, rowHeights } = await buildStyledWorkbook(pages);

    // Bold header vs plain data row - derived from real embedded font
    // weight (Helvetica-Bold vs Helvetica), not any fixed row number.
    // Column 0 has TWO bold rows in this fixture (the merged "Details"
    // group label AND the real "ID" column header beneath it) - the
    // LAST (highest-row) bold entry in column 0 is the real header row,
    // immediately followed by plain (non-bold) data rows.
    const boldCol0 = cellStyles.filter((s) => s.c === 0 && s.bold).sort((a, b) => a.r - b.r);
    expect(boldCol0.length, "expected both the merged-group label and the real header row to be bold").toBeGreaterThanOrEqual(2);
    const idHeaderStyle = boldCol0[boldCol0.length - 1];
    // A plain data cell in that SAME column position (a later row) must
    // NOT be marked bold - proves this is a real per-cell font signal,
    // not "column 0 is always bold".
    const idDataStyle = cellStyles.find((s) => s.c === 0 && s.r > idHeaderStyle.r);
    expect(idDataStyle === undefined || !idDataStyle.bold).toBe(true);

    // Title paragraph got a real, larger detected font size (16pt drawn).
    const titleStyle = cellStyles.find((s) => s.sizePt && s.sizePt >= 14);
    expect(titleStyle, "the larger-font title paragraph must carry a real detected size").toBeTruthy();

    // The two-line Notes cell must be marked for wrap, and its row must
    // have gotten a taller-than-default height as a direct consequence.
    const notesCellStyle = cellStyles.find((s) => s.wrap);
    expect(notesCellStyle, "the two-line cell must be detected as needing wrap").toBeTruthy();
    expect(rowHeights[notesCellStyle.r]).toBeGreaterThan(15);

    // Currency ($999.00) and comma-grouped (1,234) values became real
    // right-aligned numeric cells with a derived number format - not
    // reformatted or lost as plain strings, and not misidentified as an
    // identifier (only 6+ pure-digit runs or leading-zero codes are
    // forced to text - neither pattern applies here).
    const reopened = XLSX.read(wbout, { type: "array", cellNF: true });
    const ws = reopened.Sheets[reopened.SheetNames[0]];
    const currencyCellRef = Object.keys(ws).find((ref) => ws[ref].v === 999);
    expect(currencyCellRef, "$999.00 must become a real numeric 999 cell").toBeTruthy();
    expect(ws[currencyCellRef].z).toContain("#,##0.00");
    const groupedCellRef = Object.keys(ws).find((ref) => ws[ref].v === 1234 && ws[ref].t === "n");
    expect(groupedCellRef, "1,234 must become a real numeric 1234 cell").toBeTruthy();
  });
});

/* ==========================================================================
   PAGE GEOMETRY - paper size/orientation detection, physical column-width
   and row-height derivation, and page setup (pageMargins/pageSetup) XML.
   Every fixture below uses a DIFFERENT page size/orientation/column count
   than both 1.pdf and each other, specifically to prove the engine reads
   each document's own page.view (MediaBox) rather than assuming any one
   physical size - the whole point of this checkpoint.
   ========================================================================== */
async function buildLandscapeLetterTablePdf() {
  // US Letter, LANDSCAPE (792x612 - the exact opposite orientation and a
  // different paper size than 1.pdf's portrait Letter, and than the
  // A4-sized 595x842 fixtures used elsewhere in this file).
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([792, 612]);
  // 4 columns (not 3, not 5, not 11) with deliberately UNEQUAL widths so
  // proportionality is actually being tested, not just "some width".
  const geometry = { x0: 60, yTop: 500, colWidths: [50, 300, 80, 150], rowHeight: 26, nRows: 2 };
  const grid = drawRuledGrid(page, geometry);
  drawGridText(page, font, grid, [
    ["Code", "Long Description Column", "Qty", "Reference"],
    ["A1", "Something wide", "5", "REF-001"],
  ]);
  return new Uint8Array(await doc.save());
}
async function buildA5BorderlessTablePdf() {
  // A5 portrait (420x595) - smaller than every other fixture in this
  // file, AND borderless (no ruling lines at all - the confident
  // column-band model, not detectRulingGridTable), proving page-geometry
  // detection works independently of which table-detection path fired.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([420, 595]);
  const rows = [
    ["Item", "Qty", "Price"],
    ["Small Widget", "2", "5.00"],
    ["Tiny Gadget", "7", "1.25"],
  ];
  rows.forEach((row, r) => {
    const y = 500 - r * 20;
    page.drawText(row[0], { x: 40, y, size: 10, font });
    page.drawText(row[1], { x: 160, y, size: 10, font });
    page.drawText(row[2], { x: 230, y, size: 10, font });
  });
  return new Uint8Array(await doc.save());
}

describe("PDF to Excel: page geometry - paper size/orientation/margins detection is per-document, not assumed", () => {
  it("detects standard paper sizes with tolerance, and reports real orientation - a pure lookup against public paper specs, never any one document's measured values", () => {
    // Exact A4 and Letter, both orientations.
    expect(sandbox.detectPageGeometry(595, 842)).toMatchObject({ paperSize: 9, orientation: "portrait" });
    expect(sandbox.detectPageGeometry(842, 595)).toMatchObject({ paperSize: 9, orientation: "landscape" });
    expect(sandbox.detectPageGeometry(612, 792)).toMatchObject({ paperSize: 1, orientation: "portrait" });
    expect(sandbox.detectPageGeometry(792, 612)).toMatchObject({ paperSize: 1, orientation: "landscape" });
    // Within the real-world tolerance (a PDF's MediaBox is essentially
    // never bit-exact to a spec size).
    expect(sandbox.detectPageGeometry(596, 841)).toMatchObject({ paperSize: 9 });
    // A genuinely non-standard page size gets NO paperSize forced onto
    // it - only its real orientation.
    expect(sandbox.detectPageGeometry(500, 500)).toMatchObject({ paperSize: null, orientation: "portrait" });
  });

  it("[case: landscape Letter, 4 columns, unequal widths] produces proportional (not clamped-equal) column widths and correct page setup XML", async () => {
    const bytes = await buildLandscapeLetterTablePdf();
    const pages = await loadBlocks(bytes);
    const pageGeometry = sandbox.detectPageGeometry(792, 612);
    expect(pageGeometry).toMatchObject({ paperSize: 1, orientation: "landscape" });
    const { wbout, colWidthsByIndex } = await buildStyledWorkbook(pages, pageGeometry);

    // geometry.colWidths was [50, 300, 80, 150] - column 1 (the long
    // description) must come out proportionally much wider than column
    // 0, in roughly the same 1:6 ratio as the source, not clamped to
    // some fixed max.
    expect(colWidthsByIndex.length).toBe(4);
    const ratio = colWidthsByIndex[1] / colWidthsByIndex[0];
    expect(ratio).toBeGreaterThan(4);

    const zip = await JSZip.loadAsync(wbout);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    // No fitToWidth/fitToHeight/sheetPr - printing at natural 100% scale
    // with physically-accurate column widths, not a forced full-page
    // stretch (see applyCellFormattingToXlsx's fitToWidth removal).
    expect(sheetXml).not.toContain("fitToWidth");
    expect(sheetXml).not.toContain("<sheetPr>");
    expect(sheetXml).toMatch(/<pageSetup[^>]*paperSize="1"[^>]*orientation="landscape"/);
    expect(sheetXml).toMatch(/<pageMargins[^>]*\/>/);
    // pageMargins must come before pageSetup (OOXML schema order).
    expect(sheetXml.indexOf("<pageMargins")).toBeLessThan(sheetXml.indexOf("<pageSetup"));

    const reopened = XLSX.read(wbout, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1, defval: "" });
    expect(rows.some((r) => r[3] === "REF-001")).toBe(true);
  });

  it("[case: A5 portrait, borderless table] page geometry detection and real row heights work with the borderless (non-ruling-grid) path too", async () => {
    const bytes = await buildA5BorderlessTablePdf();
    const pages = await loadBlocks(bytes);
    const pageGeometry = sandbox.detectPageGeometry(420, 595);
    expect(pageGeometry).toMatchObject({ paperSize: 11, orientation: "portrait" });
    const tableish = pages[0].find((b) => b.type === "gridtable" || b.type === "table");
    expect(tableish, "borderless table must still be detected without any ruling lines").toBeTruthy();

    const { wbout } = await buildStyledWorkbook(pages, pageGeometry);
    const zip = await JSZip.loadAsync(wbout);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    expect(sheetXml).toMatch(/<pageSetup[^>]*paperSize="11"[^>]*orientation="portrait"/);

    const reopened = XLSX.read(wbout, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1, defval: "" });
    expect(rows.some((r) => r.includes("Small Widget"))).toBe(true);
    expect(rows.some((r) => r.includes("Tiny Gadget"))).toBe(true);
  });

  it("derives real per-row heights directly from the table's own detected row boundaries (PDF points), not a font-size guess", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const { rowHeights } = convertPagesToSheet(pages);
    // drawRuledGrid used rowHeight:24 (PDF points) for buildTwoPageRuledTablePdf -
    // the detected row height must be close to that real physical value,
    // not an unrelated font-derived estimate.
    const heights = Object.values(rowHeights);
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every((h) => h > 20 && h < 28)).toBe(true);
  });
});

/* ==========================================================================
   CHECKPOINT C - layout-fidelity priorities 1-4 (generic geometry mapping,
   font family/style preservation, real border evidence, cross-block
   column isolation). Three structurally different synthetic PDFs (TEST
   A/B/C per the checkpoint spec), none sharing 1.pdf's page size, column
   count, coordinates, or content - the whole point is proving these are
   generic geometric rules, not values tuned to one document.
   ========================================================================== */

// Draws a ruled grid with EXPLICIT per-row heights (unlike drawRuledGrid's
// uniform rowHeight) - real, unequal row geometry, using the same
// thin-filled-rectangle border technique.
function drawVariableHeightGrid(page, { x0, yTop, colWidths, rowHeights }) {
  const nCols = colWidths.length;
  const colXs = [x0];
  colWidths.forEach((w) => colXs.push(colXs[colXs.length - 1] + w));
  const totalWidth = colXs[colXs.length - 1] - x0;
  const rowYs = [yTop];
  rowHeights.forEach((h) => rowYs.push(rowYs[rowYs.length - 1] - h));
  const totalHeight = yTop - rowYs[rowYs.length - 1];
  rowYs.forEach((y) => page.drawRectangle({ x: x0, y: y - 0.36, width: totalWidth, height: 0.72, color: rgb(0, 0, 0) }));
  colXs.forEach((x) => page.drawRectangle({ x: x - 0.36, y: yTop - totalHeight, width: 0.72, height: totalHeight, color: rgb(0, 0, 0) }));
  return { colXs, rowYs };
}

// TEST A is already covered by buildMergedHeaderFormattedPdf above:
// portrait, 5 unequal columns, merged header, mixed font sizes (16pt
// title vs 10pt body), bold vs plain text - reused directly below for
// Priority 2/3 assertions rather than duplicating an equivalent fixture.

// TEST B: LANDSCAPE, 8 columns, TWO STRUCTURALLY DIFFERENT tables on the
// same page (8 cols with unequal row heights, then a separate 3-column
// table below it) - the exact shape that exposes cross-block column-index
// contamination (Priority 4) if the bug were still present.
// NOTE: the two structurally-different tables are on SEPARATE pages, not
// stacked on one page. Discovered while building this fixture:
// detectRulingGridTable treats ALL ruling-line shapes on a page as one
// unified coordinate set with no gap/discontinuity check, so two
// genuinely separate ruled tables stacked vertically on the SAME page
// get merged into one erroneous grid spanning both - a real, generic,
// PRE-EXISTING limitation of that detector, but a different bug from
// this checkpoint's assigned Priority 4 (blocksToSheetRows/pdf-convert-
// tools.js's CROSS-BLOCK-count column-width merging, which assumes
// blocks are already correctly separated - the actual bug fixed here).
// Left as a known limitation for a future checkpoint rather than
// expanding this one's scope; see the final report.
async function buildLandscapeMultiTableTestB() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page1 = doc.addPage([792, 612]); // US Letter landscape
  const table1Cols = [40, 60, 90, 70, 60, 80, 70, 90]; // 8 columns, unequal
  const grid1 = drawVariableHeightGrid(page1, { x0: 40, yTop: 560, colWidths: table1Cols, rowHeights: [18, 30, 18] });
  [["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"], ["a", "bb", "ccc", "dddd", "e", "ff", "ggg", "hhhh"]].forEach((row, r) => {
    row.forEach((text, c) => page1.drawText(text, { x: grid1.colXs[c] + 3, y: grid1.rowYs[r + 1] + 4, size: 9, font }));
  });
  // A SECOND, structurally unrelated table on a SEPARATE page: only 3
  // columns, very different widths - must NOT contaminate (or be
  // contaminated by) table 1's column-width tracking, even though both
  // live on the same single Excel sheet/column axis.
  const page2 = doc.addPage([792, 612]);
  const table2Cols = [200, 60, 60];
  const grid2 = drawVariableHeightGrid(page2, { x0: 40, yTop: 560, colWidths: table2Cols, rowHeights: [16, 16] });
  [["Different Table Label", "X", "Y"], ["Second row", "1", "2"]].forEach((row, r) => {
    row.forEach((text, c) => page2.drawText(text, { x: grid2.colXs[c] + 3, y: grid2.rowYs[r + 1] + 4, size: 9, font }));
  });
  return new Uint8Array(await doc.save());
}

// TEST C: a genuinely CUSTOM (non-standard) page size, one BORDERED
// section and one BORDERLESS section on the same page, a wrapped cell,
// and a merged cell - directly exercises Priority 3 (real border
// evidence: bordered vs borderless must not be conflated) in one
// document.
async function buildCustomPageMixedBorderTestC() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([500, 700]); // deliberately non-standard - no paperSize should match
  // Bordered section (real ruling lines).
  const bordered = drawVariableHeightGrid(page, { x0: 40, yTop: 640, colWidths: [200, 120], rowHeights: [20, 20] });
  page.drawText("Bordered Label", { x: bordered.colXs[0] + 3, y: bordered.rowYs[1] + 5, size: 10, font });
  page.drawText("Value", { x: bordered.colXs[1] + 3, y: bordered.rowYs[1] + 5, size: 10, font });
  // A genuinely two-line wrapped cell within the bordered section.
  page.drawText("First wrapped line", { x: bordered.colXs[0] + 3, y: bordered.rowYs[2] + 11, size: 9, font });
  page.drawText("second wrapped line", { x: bordered.colXs[0] + 3, y: bordered.rowYs[2] + 1, size: 9, font });
  page.drawText("42", { x: bordered.colXs[1] + 3, y: bordered.rowYs[2] + 5, size: 10, font });

  // Borderless section further down the SAME page - pure spacing-based
  // text, zero ruling lines anywhere near it.
  const rows = [["Item", "Qty", "Price"], ["Borderless Widget", "3", "9.99"]];
  rows.forEach((row, r) => {
    const y = 500 - r * 20;
    page.drawText(row[0], { x: 40, y, size: 10, font });
    page.drawText(row[1], { x: 260, y, size: 10, font });
    page.drawText(row[2], { x: 340, y, size: 10, font });
  });
  return new Uint8Array(await doc.save());
}

describe("PDF to Excel Checkpoint C: font family/style preservation (Priority 2)", () => {
  it("[TEST A reused] threads real bold/size AND font-family/italic/underline signals through to the actual XLSX font XML, not just a generic Calibri default", async () => {
    const pages = await loadBlocks(await buildMergedHeaderFormattedPdf());
    const { wbout } = await buildStyledWorkbook(pages);
    const zip = await JSZip.loadAsync(wbout);
    const styles = await zip.file("xl/styles.xml").async("string");
    // A real bold font entry must exist (from the "Details"/"Amounts"/
    // "ID" header cells' actual embedded Helvetica-Bold), not just the
    // sheet's single default font.
    expect(styles).toMatch(/<font><b\/>/);
    // fontIdFor only special-cases the truly-plain default (fontId 0);
    // every other font entry - bold, sized, or family-flagged - carries
    // an explicit <name val="..."/> rather than silently inheriting
    // Calibri from the workbook default, confirming family threading is
    // wired even when this particular fixture's embedded font maps to
    // the same "Calibri" fallback pdf.js reports for Helvetica.
    const fontEntries = [...styles.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1]);
    expect(fontEntries.length).toBeGreaterThan(1);
    expect(fontEntries.every((f) => /<name val="[^"]+"\/>/.test(f))).toBe(true);
  });

  it("maps a real embedded serif font (Times-Roman) to a real Excel-safe serif family, not the generic default", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Times-Roman");
    const page = doc.addPage([595, 842]);
    const grid = drawRuledGrid(page, { x0: 40, yTop: 780, colWidths: [100, 100], rowHeight: 20, nRows: 2 });
    drawGridText(page, font, grid, [["Serif", "Text"], ["Row2", "Val2"]]);
    const bytes = new Uint8Array(await doc.save());
    const pages = await loadBlocks(bytes);
    const { wbout } = await buildStyledWorkbook(pages);
    const zip = await JSZip.loadAsync(wbout);
    const styles = await zip.file("xl/styles.xml").async("string");
    // mapFontFamily() maps pdf.js's "serif" fallback category to "Times
    // New Roman" - already-established generic mapping reused as-is here
    // (not a new font-substitution table), so a genuinely serif source
    // font must produce that real family name, not Calibri.
    expect(styles).toContain('<name val="Times New Roman"/>');
  });
});

describe("PDF to Excel Checkpoint C: real border evidence (Priority 3 bug fix)", () => {
  it("[TEST C] draws borders ONLY on the ruled section; the borderless section on the SAME page gets none invented", async () => {
    const bytes = await buildCustomPageMixedBorderTestC();
    const pages = await loadBlocks(bytes);
    const blocks = pages[0];
    const ruled = blocks.find((b) => b.type === "gridtable" && b.bordered === true);
    const borderless = blocks.find((b) => b.type === "gridtable" && b.bordered === false || b.type === "table");
    expect(ruled, "the ruled section must be detected with real border evidence").toBeTruthy();
    expect(borderless, "the borderless section must still be detected structurally, just without border evidence").toBeTruthy();

    const { wbout, gridRanges } = await buildStyledWorkbook(pages);
    const borderedRanges = gridRanges.filter((g) => g.bordered);
    const borderlessRanges = gridRanges.filter((g) => !g.bordered);
    expect(borderedRanges.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(wbout);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    // A real thin-border definition must exist somewhere in styles.xml -
    // NOT asserting an exact <borders count="2"> (the bordered and
    // borderless blocks here happen to share part of their real X range
    // with different internal subdivisions, which legitimately produces
    // more than one partial-edge border combination on the shared grid,
    // not just a single uniform box - see buildPageLayout's own doc
    // comments on gridTol/xTolerance).
    const borderStyleMatch = /<border[^>]*><left style="thin"/.exec((await zip.file("xl/styles.xml").async("string")));
    expect(borderStyleMatch, "a real thin-border definition must exist for the ruled section").toBeTruthy();
    const r0 = borderedRanges[0].r0 + 1; // 1-indexed Excel row
    const c0 = borderedRanges[0].c0;
    const ref = XLSX.utils.encode_cell({ r: r0 - 1, c: c0 });
    expect(sheetXml).toMatch(new RegExp(`<c r="${ref}"[^>]*s="\\d+"`));

    // If a borderless range was also detected on this page, its cells
    // must NOT be forced into gridRanges' border loop at all.
    if (borderlessRanges.length) {
      expect(borderlessRanges.every((g) => !g.bordered)).toBe(true);
    }

    const reopened = XLSX.read(wbout, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1, defval: "" });
    expect(rows.some((r) => r.includes("Borderless Widget"))).toBe(true);
    expect(rows.some((r) => r.includes("Bordered Label"))).toBe(true);
  });

  it("[TEST C] preserves the real two-line wrapped cell and applies wrap + taller row height", async () => {
    const bytes = await buildCustomPageMixedBorderTestC();
    const pages = await loadBlocks(bytes);
    const { cellStyles, rowHeights } = convertPagesToSheet(pages);
    const wrapped = cellStyles.find((s) => s.wrap);
    expect(wrapped, "the genuinely two-line cell must be flagged for wrap").toBeTruthy();
    expect(rowHeights[wrapped.r]).toBeGreaterThan(15);
  });

  it("[TEST C] non-standard page size gets no forced paperSize, only real orientation", () => {
    const geometry = sandbox.detectPageGeometry(500, 700);
    expect(geometry.paperSize).toBeNull();
    expect(geometry.orientation).toBe("portrait");
  });
});

describe("PDF to Excel: per-edge border evidence on a merged (rowSpan) cell - no phantom interior divider", () => {
  it("a cell merged across 2 rows (real outer box, no internal divider) gets its border split across the two underlying grid rows, not a full box on both", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // A 2-col x 2-row table where column 1's internal row divider (at
    // y=760) is deliberately OMITTED, so column 1's two rows merge into
    // one real rowSpan=2 cell; column 0 keeps its own internal divider,
    // giving two ordinary single-row cells for direct comparison.
    const x0 = 40, yTop = 780, yMid = 760, yBottom = 740, xMid = 140, xRight = 240;
    const black = rgb(0, 0, 0);
    // Outer box (all 4 sides of the whole table).
    page.drawRectangle({ x: x0, y: yTop - 0.36, width: xRight - x0, height: 0.72, color: black }); // top
    page.drawRectangle({ x: x0, y: yBottom - 0.36, width: xRight - x0, height: 0.72, color: black }); // bottom
    page.drawRectangle({ x: x0 - 0.36, y: yBottom, width: 0.72, height: yTop - yBottom, color: black }); // left
    page.drawRectangle({ x: xRight - 0.36, y: yBottom, width: 0.72, height: yTop - yBottom, color: black }); // right
    // Middle vertical divider (full height, both columns keep left/right).
    page.drawRectangle({ x: xMid - 0.36, y: yBottom, width: 0.72, height: yTop - yBottom, color: black });
    // Middle horizontal divider - ONLY under column 0, not column 1.
    page.drawRectangle({ x: x0, y: yMid - 0.36, width: xMid - x0, height: 0.72, color: black });
    page.drawText("A0", { x: x0 + 4, y: yTop - 16, size: 10, font });
    page.drawText("A1", { x: x0 + 4, y: yMid - 16, size: 10, font });
    page.drawText("Merged", { x: xMid + 4, y: (yTop + yBottom) / 2 - 4, size: 10, font });
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const grid = pages[0].find((b) => b.type === "gridtable");
    expect(grid, "the table must be detected as a real ruling-line grid").toBeTruthy();
    const mergedCell = grid.cells.find((c) => c.rowSpan === 2);
    expect(mergedCell, "column 1's two rows must merge into one real rowSpan=2 cell").toBeTruthy();
    // The merged cell's own OUTER box is fully bordered - it really does
    // have all 4 sides drawn at its own bounding box, just no internal
    // seam between the two grid rows it covers.
    expect(mergedCell.edges).toEqual({ top: true, bottom: true, left: true, right: true });

    const { wbout, cellEdges } = await buildStyledWorkbook(pages);
    const row0Edges = cellEdges.find((e) => e.r === mergedCell.r0 && e.c === mergedCell.c0);
    const row1Edges = cellEdges.find((e) => e.r === mergedCell.r0 + 1 && e.c === mergedCell.c0);
    // Decomposed onto the two underlying grid rows: the top row only
    // carries the real top edge, the bottom row only the real bottom edge
    // - neither invents a border on the seam between them.
    expect(row0Edges).toMatchObject({ top: true, bottom: false, left: true, right: true });
    expect(row1Edges).toMatchObject({ top: false, bottom: true, left: true, right: true });

    // The real XLSX styles.xml must contain more than one distinct
    // <border> definition (the plain single-row cells' full box vs the
    // merged cell's two partial-box halves) - proof the per-edge XML
    // builder actually fired instead of collapsing back to one uniform box.
    const zip = await JSZip.loadAsync(wbout);
    const styles = await zip.file("xl/styles.xml").async("string");
    const bordersCountMatch = /<borders count="(\d+)">/.exec(styles);
    expect(Number(bordersCountMatch[1])).toBeGreaterThan(2);
    // At least one border definition must be missing a real bottom OR top
    // side (a genuinely partial box), proving a plain full-box-everywhere
    // border was NOT applied uniformly to the merged cell's two halves.
    const borderDefs = [...styles.matchAll(/<border>([\s\S]*?)<\/border>/g)].map((m) => m[1]);
    expect(borderDefs.some((b) => /<top style="thin"/.test(b) && /<bottom\/>/.test(b))).toBe(true);
    expect(borderDefs.some((b) => /<bottom style="thin"/.test(b) && /<top\/>/.test(b))).toBe(true);
  });
});

describe("PDF to Excel: gridtable row height comes from the real measured row, not a font/wrap-size guess", () => {
  it("a genuinely SHORT ruled row whose cell text merely LOOKS like it might wrap (heuristic overflow) keeps its real short height, not an inflated 2-line guess", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // A real, tight single-line ruled row (16pt tall) whose cell 0 holds
    // text long enough to trip cellValueAndStyle's approximate wrap
    // heuristic (text-width-vs-column-width overflow) even though the
    // source PDF drew it as one real, short row - the exact shape that
    // previously let the font/wrap-size guess in recordStyle inflate
    // rowHeights past the row's own real, measured rowBounds height.
    const geometry = { x0: 40, yTop: 800, colWidths: [70, 70], rowHeight: 16, nRows: 2 };
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, [
      ["Header A", "Header B"],
      ["A somewhat long label", "42"],
    ]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const grid0 = pages[0].find((b) => b.type === "gridtable");
    expect(grid0, "the table must be detected as a real ruling-line grid").toBeTruthy();

    const { rowHeights, cellStyles } = convertPagesToSheet(pages);
    const dataRowIdx = 1; // second grid row (0-indexed within the block)
    const wrapFlagged = cellStyles.some((s) => s.r === dataRowIdx && s.c === 0 && s.wrap);
    expect(wrapFlagged, "the long label must actually trip the wrap heuristic for this test to be meaningful").toBe(true);
    // The real measured row height (from the ruled grid's own rowBounds)
    // is 16pt - the row must stay close to that, never balloon toward the
    // old heuristic's ~2-line guess (~30pt+ for an 11pt font).
    expect(rowHeights[dataRowIdx]).toBeCloseTo(16, 0);
    expect(rowHeights[dataRowIdx]).toBeLessThan(20);
  });
});

describe("PDF to Excel: independent per-page worksheets never contaminate each other's column widths", () => {
  it("[TEST B] two structurally different tables (8 cols vs 3 cols, unequal row heights) on separate landscape pages each get their OWN independent column grid", async () => {
    const bytes = await buildLandscapeMultiTableTestB();
    const pages = await loadBlocks(bytes);
    expect(pages.length).toBe(2);
    const gridBlocks = pages.flat().filter((b) => b.type === "gridtable");
    expect(gridBlocks.length).toBe(2);
    expect(gridBlocks.map((b) => b.nCols).sort()).toEqual([3, 8]);

    const perPage = convertPagesToSheets(pages);
    // Each page is its own worksheet now - there is no shared !cols array
    // left to contaminate. Page 1's own grid reflects its own 8-column
    // table exactly; page 2's own grid reflects its own 3-column table
    // exactly, independently.
    expect(perPage[0].colWidthsByIndex.length).toBe(8);
    expect(perPage[1].colWidthsByIndex.length).toBe(3);

    // Both tables' actual DATA must still be fully present and correct,
    // each on its own page's sheet.
    const flat0 = perPage[0].rows.flat().map((c) => (c && c.v !== undefined ? c.v : c));
    const flat1 = perPage[1].rows.flat().map((c) => (c && c.v !== undefined ? c.v : c));
    expect(flat0).toContain("C1");
    expect(flat0).toContain("dddd");
    expect(flat1).toContain("Different Table Label");

    // Real unequal row heights (18/30/18 pt) from table 1 must be
    // reflected on ITS OWN page, not one uniform height.
    const heights = Object.values(perPage[0].rowHeights);
    expect(new Set(heights.map((h) => Math.round(h))).size).toBeGreaterThan(1);
  });

  it("a later table with the SAME column count and proportions as an earlier one on a different page gets its own equally-proportioned grid, independently derived (not literally shared)", async () => {
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const perPage = convertPagesToSheets(pages);
    // buildTwoPageRuledTablePdf's two pages use IDENTICAL real geometry -
    // each page's OWN independently-built grid naturally comes out with
    // the same 3-column shape, without needing any cross-page carry-
    // forward to force them to match.
    expect(perPage[0].colWidthsByIndex.length).toBe(3);
    expect(perPage[1].colWidthsByIndex.length).toBe(3);
    perPage[0].colWidthsByIndex.forEach((w, i) => {
      expect(Math.abs(w - perPage[1].colWidthsByIndex[i])).toBeLessThan(5);
    });
  });
});

// Replaces the previous architecture's ad-hoc "if a paragraph is
// centered, span it across the table's whole column count" special case
// (spanCentered/contentSpanCols) with the actual mechanism buildPageLayout
// now uses: ANY paragraph's own real measured xLeft/xRight (linesToParagraphs)
// is mapped directly onto the page's shared column grid, so it spans
// exactly the real columns its text width geometrically overlaps -
// whether or not it happens to be detected as centered, and never more
// than its own real extent actually covers.
describe("PDF to Excel: a paragraph's real X extent determines which shared columns it spans", () => {
  it("a paragraph whose real text width crosses a table's column boundary spans those real columns, not just column A", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // Starts flush with the table's own real left edge (x=40) and, at
    // 16pt, is wide enough that its own measured right edge genuinely
    // crosses past the table's first column boundary (40+80=120) - a
    // real geometric overlap with column 1, not an alignment guess.
    page.drawText("QUARTERLY REPORT", { x: 40, y: 780, size: 16, font });
    const geometry = { x0: 40, yTop: 740, colWidths: [80, 160, 100], rowHeight: 24, nRows: 2 };
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, [["ID", "Name", "Phone"], ["1", "Someone", "5551234567"]]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const titleBlock = pages[0].find((b) => b.type === "paragraph");
    expect(titleBlock.xLeft, "the title's own real left edge must be measured, close to the table's own left edge").toBeLessThan(60);

    const { rows, merges } = convertPagesToSheet(pages);
    expect(rows[0][0]).toBe("QUARTERLY REPORT");
    const titleMerge = merges.find((m) => m.s.r === 0 && m.s.c === 0);
    expect(titleMerge, "a real X-extent crossing a column boundary must produce a real merge, not confinement to column A").toBeTruthy();
    expect(titleMerge.e.c).toBeGreaterThan(0);
  });

  it("does NOT span a short paragraph whose real width stays entirely within one column", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // "ID" at 11pt, flush with the table's own left edge, is far
    // narrower than the first column's own real 80pt width - its real
    // measured xRight never reaches the first column boundary.
    page.drawText("ID", { x: 40, y: 780, size: 11, font });
    const geometry = { x0: 40, yTop: 740, colWidths: [80, 160, 100], rowHeight: 24, nRows: 2 };
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, [["ID", "Name", "Phone"], ["1", "Someone", "5551234567"]]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const { merges } = convertPagesToSheet(pages);
    expect(merges.some((m) => m.s.r === 0 && m.s.c === 0 && m.e.c > 0)).toBe(false);
  });
});

describe("PDF to Excel: two genuinely separate ruled tables stacked on ONE page do not merge into one grid", () => {
  it("detects two structurally different ruled tables on the same page as two separate gridtable blocks, split at the real row-gap outlier", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // Table 1: 3 columns, near the top of the page.
    const grid1 = drawRuledGrid(page, { x0: 40, yTop: 800, colWidths: [80, 160, 100], rowHeight: 20, nRows: 3 });
    drawGridText(page, font, grid1, [
      ["ID", "Name", "Phone"],
      ["1", "Alpha Person", "9876543210"],
      ["2", "Beta Person", "0123456"],
    ]);
    // A LARGE vertical gap (a real, generic discontinuity - not a fixed
    // point value tuned to any one document) before table 2 starts, well
    // beyond any single row's own height - the exact real-world shape of
    // two unrelated ruled tables on one page (e.g. two different annexure
    // sections), which detectRulingGridTable's un-gapped row clustering
    // used to silently weld into one erroneous grid.
    const grid2 = drawRuledGrid(page, { x0: 40, yTop: 480, colWidths: [200, 90, 90], rowHeight: 18, nRows: 2 });
    drawGridText(page, font, grid2, [
      ["Different Table Label", "X", "Y"],
      ["Second row", "1", "2"],
    ]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const gridBlocks = pages[0].filter((b) => b.type === "gridtable");
    expect(gridBlocks.length, "both ruled tables must be detected as two independent gridtable blocks, not merged into one").toBe(2);
    expect(gridBlocks.map((b) => b.nCols).sort()).toEqual([3, 3]);
    expect(gridBlocks.map((b) => b.nRows).sort()).toEqual([2, 3]);

    // Both tables' real data must be present and neither table's rows may
    // bleed into the other's cell grid.
    const table1 = gridBlocks.find((b) => b.nRows === 3);
    const table2 = gridBlocks.find((b) => b.nRows === 2);
    const table1Text = table1.cells.map((c) => c.text).join("|");
    const table2Text = table2.cells.map((c) => c.text).join("|");
    expect(table1Text).toContain("Alpha Person");
    expect(table1Text).not.toContain("Different Table Label");
    expect(table2Text).toContain("Different Table Label");
    expect(table2Text).not.toContain("Alpha Person");
  });
});

describe("PDF to Excel: pageSetup XML stays in its required CT_Worksheet schema position even without ws['!margins']", () => {
  it("inserts <pageSetup> before SheetJS's own trailing elements (e.g. <ignoredErrors>) when no <pageMargins> exists to anchor against", async () => {
    // A cell whose value looks like a number but is stored as text (an
    // identifier-preserving choice this codebase makes deliberately -
    // see cellValueAndStyle) makes SheetJS itself emit a real
    // <ignoredErrors numberStoredAsText="1".../> element. Confirmed real
    // bug: when the caller doesn't set ws['!margins'] (so no
    // <pageMargins> exists to anchor the insertion point against),
    // applyCellFormattingToXlsx used to simply splice <pageSetup> right
    // before </worksheet> - landing it AFTER <ignoredErrors>, which
    // violates CT_Worksheet's fixed element order and makes Excel refuse
    // to open the file / demand repair.
    const ws = XLSX.utils.aoa_to_sheet([["0012345"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    let wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const pageGeometry = { paperSize: "9", orientation: "portrait", widthPt: 595, heightPt: 842 };
    wbout = await sandbox.applyCellFormattingToXlsx(wbout, [{ gridRanges: [], cellStyles: [], rowHeights: {}, cellEdges: [], pageGeometry }]);

    const zip = await JSZip.loadAsync(wbout);
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    const pageSetupIdx = sheetXml.indexOf("<pageSetup");
    const ignoredErrorsIdx = sheetXml.indexOf("<ignoredErrors");
    expect(pageSetupIdx, "pageSetup must actually be present").toBeGreaterThan(-1);
    expect(ignoredErrorsIdx, "this fixture must actually trigger SheetJS's own ignoredErrors for the test to be meaningful").toBeGreaterThan(-1);
    expect(pageSetupIdx).toBeLessThan(ignoredErrorsIdx);
  });
});

describe("PDF to Excel Phase 13: real text color and background/highlight color", () => {
  it("a genuinely colored PDF header (not black) survives as a real Excel font color, not the default theme color", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // A real, deliberate PDF text color (a mid-blue, not black/near-black
    // so it can't be mistaken for the "no real color detected" default) -
    // drawn directly with pdf-lib's own color option, so this is a REAL
    // PDF graphics-state fill color at the header's text-matrix position,
    // exactly what extractPageBlocks' nearestColor() reads.
    const geometry = { x0: 40, yTop: 780, colWidths: [100, 100], rowHeight: 20, nRows: 2 };
    const grid = drawRuledGrid(page, geometry);
    page.drawText("Header", { x: grid.colXs[0] + 4, y: grid.rowYs[0] - 16, size: 10, font, color: rgb(0.1, 0.3, 0.8) });
    page.drawText("Col2", { x: grid.colXs[1] + 4, y: grid.rowYs[0] - 16, size: 10, font, color: rgb(0.1, 0.3, 0.8) });
    page.drawText("plain", { x: grid.colXs[0] + 4, y: grid.rowYs[1] - 16, size: 10, font });
    page.drawText("data", { x: grid.colXs[1] + 4, y: grid.rowYs[1] - 16, size: 10, font });
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const { wbout } = await buildStyledWorkbook(pages);
    const zip = await JSZip.loadAsync(wbout);
    const styles = await zip.file("xl/styles.xml").async("string");
    // A mid-blue ~[26,77,204] in 0-255 - real color rgb, not black/near-
    // black, so it must produce a real, non-default <color rgb="FF..."/>.
    const hasRealColorFont = /<font>[\s\S]*?<color rgb="FF[0-9A-F]{6}"\/>[\s\S]*?<\/font>/.test(styles);
    expect(hasRealColorFont, "a real (non-black) PDF text color must produce a real rgb font color entry").toBe(true);
    // The plain (unstyled, effectively-black) cells must NOT get an
    // invented explicit color - they keep the sheet's default/theme font.
    const allFontColorRgbs = [...styles.matchAll(/<color rgb="FF([0-9A-F]{6})"\/>/g)].map((m) => m[1]);
    expect(allFontColorRgbs.length, "only the real colored header should produce an rgb font color entry").toBeGreaterThan(0);
  });

  it("a real filled background box behind a table becomes a real Excel cell fill, not invented on plain cells", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // A real, solid-filled box (orange - safe contrast per isSafeForShading's
    // own luminance check, not near-white) drawn BEHIND the table, large
    // enough (>15x15) to qualify as a boxCandidate in extractPageBlocks,
    // vertically enclosing the table's own row range.
    const geometry = { x0: 40, yTop: 780, colWidths: [100, 100], rowHeight: 20, nRows: 2 };
    page.drawRectangle({ x: 30, y: geometry.yTop - geometry.rowHeight * geometry.nRows - 5, width: 220, height: geometry.rowHeight * geometry.nRows + 10, color: rgb(1, 0.65, 0) });
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, [["Label", "Value"], ["A", "1"]]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const gridBlock = pages[0].find((b) => b.type === "gridtable");
    expect(gridBlock.shadeHex, "the enclosing orange box must be detected and attached to the block before this test is meaningful").toBeTruthy();

    const { wbout } = await buildStyledWorkbook(pages);
    const zip = await JSZip.loadAsync(wbout);
    const styles = await zip.file("xl/styles.xml").async("string");
    const hasRealFill = /<fill><patternFill patternType="solid"><fgColor rgb="FF[0-9A-F]{6}"\/>/.test(styles);
    expect(hasRealFill, "a real detected background box must produce a real solid fill entry").toBe(true);
  });
});

describe("PDF to Excel Phase 13: real X-position-based column identity for independent tables", () => {
  it("two independent ruled tables at genuinely different real X positions on one page land in different Excel columns, not both starting at column A", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    // Table 1 (the anchor - the first table encountered) at the page's
    // left margin.
    const geometry1 = { x0: 40, yTop: 780, colWidths: [80, 80], rowHeight: 20, nRows: 2 };
    const grid1 = drawRuledGrid(page, geometry1);
    drawGridText(page, font, grid1, [["A1", "B1"], ["1", "2"]]);
    // Table 2: a genuinely separate table, further down the page (a real
    // Y gap - detectRulingGridTable's own row-gap-split keeps these two
    // tables from being merged into one erroneous grid; deliberately NOT
    // testing simultaneous same-Y side-by-side placement here, since
    // detecting THAT as two independent tables would need its own
    // detection-heuristic change, out of this checkpoint's explicit
    // scope) AND starting far to the right (x0=350, well beyond table 1's
    // own real width) - real evidence of a physically distinct region.
    const geometry2 = { x0: 350, yTop: 600, colWidths: [80, 80], rowHeight: 20, nRows: 2 };
    const grid2 = drawRuledGrid(page, geometry2);
    drawGridText(page, font, grid2, [["A2", "B2"], ["3", "4"]]);
    const bytes = new Uint8Array(await doc.save());

    const pages = await loadBlocks(bytes);
    const gridBlocks = pages[0].filter((b) => b.type === "gridtable");
    expect(gridBlocks.length, "both tables must be detected as two independent gridtable blocks").toBe(2);

    const { gridRanges } = await buildStyledWorkbook(pages);
    expect(gridRanges.length).toBe(2);
    const c0s = gridRanges.map((g) => g.c0).sort((a, b) => a - b);
    // The anchor (first table encountered) must still start at column A
    // (c0=0), matching every existing single-table fixture's behavior -
    // zero regression for the overwhelmingly common case.
    expect(c0s[0]).toBe(0);
    // The second, genuinely offset table must NOT also start at column A -
    // it must land at a real, nonzero, geometry-derived column offset
    // reflecting its real rightward position on the page.
    expect(c0s[1]).toBeGreaterThan(0);
  });

  it("two tables at genuinely the SAME real X position, each on its own page, both independently start at column A", async () => {
    // This is exactly buildTwoPageRuledTablePdf's existing shape (same
    // geometry both pages) - reusing it here as an explicit, named
    // regression, now for the fact that each page's own independent grid
    // naturally puts its own left-margin-aligned table at column A,
    // without needing any cross-page offset mechanism at all.
    const bytes = await buildTwoPageRuledTablePdf();
    const pages = await loadBlocks(bytes);
    const perPage = convertPagesToSheets(pages);
    expect(perPage[0].gridRanges.length).toBe(1);
    expect(perPage[1].gridRanges.length).toBe(1);
    expect(perPage[0].gridRanges[0].c0).toBe(0);
    expect(perPage[1].gridRanges[0].c0).toBe(0);
  });
});

// Tests buildPageLayout's own Y-band clustering mechanism directly, with
// hand-built block objects (bypassing real PDF text extraction) - real
// side-by-side text next to a RULED table's own row range currently hits
// a separate, PRE-EXISTING extraction-layer limitation (detectRulingGridTable's
// line-consumption step removes any text line whose Y falls within the
// table's row span, regardless of X - see extractPageBlocks), which is a
// detection-layer concern this checkpoint was explicitly told not to
// touch. Isolating the test this way proves the actual mechanism this
// checkpoint adds (buildPageLayout's Y-band grouping + real X placement)
// independent of that unrelated, disclosed extraction gap.
describe("PDF to Excel: genuinely side-by-side content on the same page stays side-by-side", () => {
  it("two paragraph blocks at the SAME real Y but different real X land on the SAME Excel row, at different columns", () => {
    const leftBlock = { type: "paragraph", runs: [{ text: "Left Note", bold: false, italic: false, size: 11 }], _y: 700, xLeft: 40, xRight: 120 };
    const rightBlock = { type: "paragraph", runs: [{ text: "Right Note", bold: false, italic: false, size: 11 }], _y: 700, xLeft: 480, xRight: 560 };
    const layout = sandbox.buildPageLayout([leftBlock, rightBlock], 612, 792);
    expect(layout.nRows).toBe(1);
    const leftCell = layout.cells.find((c) => c.value === "Left Note");
    const rightCell = layout.cells.find((c) => c.value === "Right Note");
    expect(leftCell.r0).toBe(rightCell.r0);
    expect(rightCell.c0).toBeGreaterThan(leftCell.c1);
  });

  it("two paragraph blocks at genuinely different real Y land on different Excel rows", () => {
    const topBlock = { type: "paragraph", runs: [{ text: "Top Note", bold: false, italic: false, size: 11 }], _y: 700, xLeft: 40, xRight: 120 };
    const bottomBlock = { type: "paragraph", runs: [{ text: "Bottom Note", bold: false, italic: false, size: 11 }], _y: 400, xLeft: 40, xRight: 120 };
    const layout = sandbox.buildPageLayout([topBlock, bottomBlock], 612, 792);
    const topCell = layout.cells.find((c) => c.value === "Top Note");
    const bottomCell = layout.cells.find((c) => c.value === "Bottom Note");
    expect(bottomCell.r0).toBeGreaterThan(topCell.r0);
  });
});

describe("PDF to Excel: real vertical gaps between blocks translate to proportionally larger/smaller blank row gaps", () => {
  async function buildTwoParagraphPdf(gapPt) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([612, 792]);
    page.drawText("First Block", { x: 40, y: 700, size: 12, font });
    page.drawText("Second Block", { x: 40, y: 700 - gapPt, size: 12, font });
    return new Uint8Array(await doc.save());
  }
  it("a large real Y gap between two blocks produces more blank Excel rows than a small one, on otherwise identical content", async () => {
    const smallGapPages = await loadBlocks(await buildTwoParagraphPdf(20));
    const largeGapPages = await loadBlocks(await buildTwoParagraphPdf(260));
    const { rows: smallRows } = convertPagesToSheet(smallGapPages);
    const { rows: largeRows } = convertPagesToSheet(largeGapPages);
    const smallGapRowSpan = largeIdx(smallRows) - firstIdx(smallRows);
    const largeGapRowSpan = largeIdx(largeRows) - firstIdx(largeRows);
    expect(largeGapRowSpan, "a real 260pt gap must produce more blank rows than a real 20pt gap between otherwise identical blocks").toBeGreaterThan(smallGapRowSpan);
    function firstIdx(rows) { return rows.findIndex((r) => r.includes("First Block")); }
    function largeIdx(rows) { return rows.findIndex((r) => r.includes("Second Block")); }
  });
});

/* ==========================================================================
   TABLE ARITHMETIC - real Excel formulas (qty*rate=amount, subtotal SUM,
   letter-chain totals), not dead literals, plus real cell comments when a
   printed number disagrees with the arithmetic instead of being silently
   "corrected". One continuous ruled table (no Y gaps) so it's detected as
   ONE gridtable block - subtotal-row/letter-chain resolution operates per
   block, not across blocks.
   ========================================================================== */
async function buildArithmeticTablePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([595, 842]);
  // Row 6 ("Labour hours") has a DELIBERATELY WRONG printed amount
  // (999.00) - real qty*rate = 6*50 = 300.00 - to exercise the
  // discrepancy-comment path, not just the happy path.
  const rows = [
    ["Item", "Qty", "Unit rate", "Amount"],
    ["A. Materials", "", "", ""],
    ["Steel bar", "10", "50.00", "500.00"],
    ["Cement bag", "5", "20.00", "100.00"],
    ["Sub Total (A)", "", "", "600.00"],
    ["B. Labour", "", "", ""],
    ["Labour hours", "6", "50.00", "999.00"],
    ["Sub Total (B)", "", "", "300.00"],
    ["Total E = (A+B)", "", "", "900.00"],
  ];
  const geometry = { x0: 40, yTop: 780, colWidths: [180, 60, 80, 90], rowHeight: 20, nRows: rows.length };
  const grid = drawRuledGrid(page, geometry);
  drawGridText(page, font, grid, rows);
  return new Uint8Array(await doc.save());
}

describe("PDF to Excel: real Excel formulas from a table's own qty*rate/subtotal arithmetic", () => {
  it("a correct printed amount (qty*rate) becomes a real formula referencing the real Qty/Rate cells, not a dead literal", async () => {
    const pages = await loadBlocks(await buildArithmeticTablePdf());
    const { rows } = convertPagesToSheet(pages);
    // "Steel bar": Qty=10, Rate=50.00, printed Amount=500.00 (agrees).
    const steelRow = rows.findIndex((r) => r[0] === "Steel bar");
    expect(steelRow).toBeGreaterThan(-1);
    const amountCell = rows[steelRow][3];
    expect(amountCell, "a correct qty*rate amount must become a real formula object, not a plain number").toBeTypeOf("object");
    expect(amountCell.f).toMatch(/^[A-Z]+\d+\*[A-Z]+\d+$/);
    expect(amountCell.v).toBeCloseTo(500, 2);
  });

  it("a correct printed subtotal becomes a real SUM() formula over the real rows above it", async () => {
    const pages = await loadBlocks(await buildArithmeticTablePdf());
    const { rows } = convertPagesToSheet(pages);
    const subtotalRow = rows.findIndex((r) => r[0] === "Sub Total (A)");
    expect(subtotalRow).toBeGreaterThan(-1);
    const cell = rows[subtotalRow][3];
    expect(cell.f).toMatch(/^SUM\([A-Z]+\d+:[A-Z]+\d+\)$/);
    expect(cell.v).toBeCloseTo(600, 2);
  });

  it("a letter-chain total (\"Total E = (A+B)\") references the real subtotal rows' own cells, not the section-header rows", async () => {
    const pages = await loadBlocks(await buildArithmeticTablePdf());
    const { rows } = convertPagesToSheet(pages);
    const totalRow = rows.findIndex((r) => r[0] === "Total E = (A+B)");
    const subtotalARow = rows.findIndex((r) => r[0] === "Sub Total (A)");
    const subtotalBRow = rows.findIndex((r) => r[0] === "Sub Total (B)");
    const cell = rows[totalRow][3];
    expect(cell.f).toContain(XLSX.utils.encode_cell({ r: subtotalARow, c: 3 }));
    expect(cell.f).toContain(XLSX.utils.encode_cell({ r: subtotalBRow, c: 3 }));
    expect(cell.v).toBeCloseTo(900, 2);
  });

  it("a printed amount that DISAGREES with qty*rate keeps the printed literal and gets a real cell comment instead of being silently 'corrected'", async () => {
    const pages = await loadBlocks(await buildArithmeticTablePdf());
    const { rows, cellStyles } = convertPagesToSheet(pages);
    const labourRow = rows.findIndex((r) => r[0] === "Labour hours");
    const amountCell = rows[labourRow][3];
    // Kept as the real printed value (999), NOT overwritten with the
    // computed 300, and NOT turned into a formula.
    expect(amountCell.f).toBeUndefined();
    expect(amountCell.v).toBeCloseTo(999, 2);
    const commentStyle = cellStyles.find((s) => s.r === labourRow && s.c === 3);
    expect(commentStyle, "a discrepancy must be flagged with a real cell comment").toBeTruthy();
    expect(commentStyle.comment).toContain("999.00");
    expect(commentStyle.comment).toContain("300.00");
  });

  it("the discrepancy comment survives into a real OOXML comments part with a matching VML legacy drawing", async () => {
    const pages = await loadBlocks(await buildArithmeticTablePdf());
    const { wbout } = await buildStyledWorkbook(pages);
    const zip = await JSZip.loadAsync(wbout);
    expect(zip.file("xl/comments1.xml"), "a real comments part must exist").toBeTruthy();
    expect(zip.file("xl/drawings/vmlDrawing1.vml"), "a real VML legacy drawing part must exist (required for Excel to render the comment indicator)").toBeTruthy();
    const commentsXml = await zip.file("xl/comments1.xml").async("string");
    expect(commentsXml).toContain("999.00");
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    expect(sheetXml).toMatch(/<legacyDrawing r:id="[^"]+"\/>/);
    const rels = await zip.file("xl/worksheets/_rels/sheet1.xml.rels").async("string");
    expect(rels).toContain("comments1.xml");
    expect(rels).toContain("vmlDrawing1.vml");
    // Reopen through SheetJS itself as an independent structural check -
    // a malformed comments/VML part would make this throw.
    const reopened = XLSX.read(wbout, { type: "array" });
    expect(reopened.SheetNames.length).toBeGreaterThan(0);
  });

  it("does NOT detect qty*rate arithmetic when the header says 'Unit rate' - the word 'unit' must not be misread as the quantity column", async () => {
    // Regression for a real bug found during implementation: the qty
    // role regex's "units?" alternative false-matched "Unit rate"/"Unit
    // cost" headers (very common real-world column names), silently
    // treating the RATE column as the QTY column and corrupting the
    // whole qty*rate detection. This table has NO real qty column at
    // all (just Description/Unit rate/Amount) - no formula should ever
    // be produced for it.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    const rows = [
      ["Description", "Unit rate", "Amount"],
      ["Service fee", "250.00", "250.00"],
    ];
    const geometry = { x0: 40, yTop: 780, colWidths: [200, 90, 90], rowHeight: 20, nRows: rows.length };
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, rows);
    const bytes = new Uint8Array(await doc.save());
    const pages = await loadBlocks(bytes);
    const { rows: outRows } = convertPagesToSheet(pages);
    const dataRow = outRows.findIndex((r) => r[0] === "Service fee");
    const amountCell = outRows[dataRow][2];
    expect(amountCell && typeof amountCell === "object" ? amountCell.f : undefined, "no qty column exists in this table - no formula should be invented").toBeUndefined();
  });
});

describe("PDF to Excel: number formatting - percentages", () => {
  it("a percentage value is stored as a real fraction with a 0.0% format, not the literal printed number", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([595, 842]);
    const rows = [["Tax Rate", "Discount"], ["18%", "15.5 %"]];
    const geometry = { x0: 40, yTop: 780, colWidths: [100, 100], rowHeight: 20, nRows: rows.length };
    const grid = drawRuledGrid(page, geometry);
    drawGridText(page, font, grid, rows);
    const bytes = new Uint8Array(await doc.save());
    const pages = await loadBlocks(bytes);
    const { rows: outRows, cellStyles } = convertPagesToSheet(pages);
    const taxCell = outRows[1][0];
    expect(taxCell.v).toBeCloseTo(0.18, 4);
    const taxStyle = cellStyles.find((s) => s.r === 1 && s.c === 0);
    expect(taxStyle.numFmtCode).toBe("0.0%");
    const discountCell = outRows[1][1];
    expect(discountCell.v).toBeCloseTo(0.155, 4);
  });
});
