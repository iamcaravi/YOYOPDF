import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const dependencyBase = process.env.YOYO_DEPENDENCY_ROOT
  ? resolve(process.env.YOYO_DEPENDENCY_ROOT, "package.json")
  : import.meta.url;
const require = createRequire(dependencyBase);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const JSZip = require("jszip");

const CHECK = process.argv.includes("--check");
const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARMAgYKSAAAMAAB0ABfob8TUAAAAASUVORK5CYII=",
  "base64"
);

// Standard PNG CRC32 (ISO 3309 / ITU-T V.42, the table PNG's own spec
// gives as its reference implementation) - needed because Node's zlib
// module deflate/inflates but exposes no CRC32, and every PNG chunk
// requires one.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
/** A real, solid-color RGB PNG at genuinely testable pixel dimensions -
 *  simple.png (2x2) is too small to prove a crop actually shrank the
 *  output (any real crop of a 2x2 source already rounds to <=2px, true
 *  whether or not cropping genuinely ran). */
function makeSolidPng(width, height, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor (RGB)
  // remaining 3 bytes (compression/filter/interlace) already zero.
  const rowBytes = 1 + width * 3; // leading filter-type byte per PNG spec
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A real PNG with an actual alpha channel (color type 6, RGBA): left
 *  half fully transparent, right half opaque with a smooth per-pixel
 *  gradient (not a flat fill). Every other PNG fixture here (simple.png,
 *  sizable.png) is opaque RGB, so none of them can exercise the
 *  "transparent PNG -> JPEG" flatten-to-white regression path - JPEG has
 *  no alpha channel, and drawing a transparent source onto a canvas's
 *  default transparent-black fill before encoding as JPEG previously
 *  baked transparent regions in as black instead of white. The opaque
 *  half is a gradient rather than a flat color specifically so deflate
 *  (PNG) can't compress it anywhere near as well as JPEG's DCT can - a
 *  flat color PNG this small round-trips smaller than any JPEG
 *  re-encode of it, which would trip the image-compressor's own "never
 *  hand back something bigger than the original" safety net and mean
 *  the compressor never actually produces JPEG bytes to test against. */
function makeTransparentPng(width, height, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: truecolor with alpha (RGBA)
  const rowBytes = 1 + width * 4; // leading filter-type byte per PNG spec
  const raw = Buffer.alloc(rowBytes * height);
  const halfW = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      if (x < halfW) {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0; // fully transparent
      } else {
        const gx = x - halfW;
        raw[px] = r;
        raw[px + 1] = (g + gx * 3) % 256;
        raw[px + 2] = (b + y * 5) % 256;
        raw[px + 3] = 255; // opaque
      }
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixedMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("YOYOPDF test fixture");
  pdf.setCreator("YOYOPDF fixture generator");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

async function makePdf(pageCount, title) {
  const pdf = await PDFDocument.create();
  fixedMetadata(pdf, title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([420, 594]);
    page.drawText(title + " - page " + (index + 1), {
      x: 36,
      y: 540,
      size: 18,
      font,
      color: rgb(0.1, 0.2, 0.5),
    });
    page.drawRectangle({
      x: 36,
      y: 420 - index * 12,
      width: 180 + index * 24,
      height: 72,
      color: rgb(0.92, 0.5, 0.15),
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function makeFormPdf() {
  const pdf = await PDFDocument.create();
  fixedMetadata(pdf, "YOYOPDF form fixture");
  const page = pdf.addPage([420, 594]);
  const form = pdf.getForm();
  const field = form.createTextField("TestField");
  field.addToPage(page, { x: 36, y: 500, width: 200, height: 24 });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) {
    zip.file(name, value, { date: FIXED_DATE, createFolders: false });
  }
  return Buffer.from(await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  }));
}

function officeFixtures() {
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;

  return {
    "minimal.docx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>YOYOPDF DOCX fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    }),
    "minimal.xlsx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>YOYOPDF</t></is></c><c r="B1"><v>11</v></c></row></sheetData></worksheet>`,
    }),
    "minimal.pptx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld></p:sld>`,
    }),
  };
}

// Merge Excel fixtures - hand-built real OOXML (not fake JSON), matching
// tests/xlsx-merge.test.js's structural assertions. workbook-a and
// workbook-b deliberately use DIFFERENT numFmt/font/fill/border indexes
// from each other so a naive "copy the style index as-is" merge would
// produce wrong formatting - only a real remap survives these fixtures.
function mergeExcelFixtures() {
  const relsHdr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;

  function contentTypes(sheetCount, extra) {
    const sheetOverrides = Array.from({ length: sheetCount }, (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extra || ""}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  }

  function workbookXml(sheetNames) {
    const sheets = sheetNames.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  }

  function workbookRels(sheetCount, extraRels) {
    const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join("");
    return relsHdr + sheetRels
      + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `<Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
      + (extraRels || "")
      + `</Relationships>`;
  }

  function sst(strings) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  }

  // ---- workbook-a.xlsx: 2 sheets, numFmt 164 = "#,##0.00", bold-header
  // style (fontId1/fillId1/borderId1), thin borders, light-blue fill.
  const aStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E8FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const aSheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C4"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="25" customWidth="1"/><col min="2" max="3" width="12" customWidth="1"/></cols><sheetData><row r="1" ht="22" customHeight="1" s="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" s="1"/><c r="C1" s="1"/></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>10</v></c><c r="C3" s="2"><v>9.99</v></c></row><row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><f>SUM(B3:B3)</f><v>10</v></c><c r="C4" s="2"><f>SUM(C3:C3)</f><v>9.99</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>`;
  const aSheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><cols><col min="1" max="2" width="18" customWidth="1"/></cols><sheetData><row r="1" ht="15" customHeight="1"><c r="A1" t="s"><v>6</v></c><c r="B1" t="s"><v>7</v></c></row><row r="2" ht="15" customHeight="1"><c r="A2" t="s"><v>8</v></c><c r="B2"><f>Sheet1!B3</f><v>10</v></c></row></sheetData></worksheet>`;
  const aSst = sst(["Quarterly Report", "Item", "Qty", "Price", "Widget", "Total", "Notes", "Value", "Reference"]);

  const workbookA = makeZip({
    "[Content_Types].xml": contentTypes(2),
    "_rels/.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml(["Sheet1", "Sheet2"]),
    "xl/_rels/workbook.xml.rels": workbookRels(2),
    "xl/styles.xml": aStyles,
    "xl/sharedStrings.xml": aSst,
    "xl/worksheets/sheet1.xml": aSheet1,
    "xl/worksheets/sheet2.xml": aSheet2,
  });

  // ---- workbook-b.xlsx: 2 sheets NAMED THE SAME as workbook-a ("Sheet1",
  // "Sheet2" - deliberate collision), numFmt 165 = "0.0%", italic-red
  // header style, thick-bottom border, yellow fill - fully different style
  // table from workbook-a so index remap correctness is actually exercised.
  const bStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="12"/><color rgb="FFCC0000"/><name val="Georgia"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thick"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const bSheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B4"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="30" customWidth="1"/></cols><sheetData><row r="1" ht="25" customHeight="1" s="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" s="1"/></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="2"><v>0.85</v></c></row><row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" s="2"><f>SUM(B3:B3)</f><v>0.85</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
  // B1's formula deliberately references THIS workbook's own "Sheet1" by
  // name - since workbook-b's "Sheet1" collides with workbook-a's and gets
  // renamed to "Sheet1 (2)" on merge, this is the exact case the engine's
  // best-effort formula sheet-reference rewrite has to handle correctly.
  const bSheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c><c r="B1"><f>Sheet1!B3</f><v>0.85</v></c></row></sheetData></worksheet>`;
  const bSst = sst(["Survey Results", "Question", "Score", "Q1", "Total", "Ref"]);

  const workbookB = makeZip({
    "[Content_Types].xml": contentTypes(2),
    "_rels/.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml(["Sheet1", "Sheet2"]),
    "xl/_rels/workbook.xml.rels": workbookRels(2),
    "xl/styles.xml": bStyles,
    "xl/sharedStrings.xml": bSst,
    "xl/worksheets/sheet1.xml": bSheet1,
    "xl/worksheets/sheet2.xml": bSheet2,
  });

  // ---- workbook-image.xlsx: 1 sheet with a real embedded drawing/image
  // (same xdr:twoCellAnchor shape doc-export-builders.js's own
  // embedImagesInXlsx() already writes), to exercise the merge engine's
  // drawing/media copy-and-rewrite path.
  const imgStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const imgSheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><drawing r:id="rIdDrawing1"/></worksheet>`;
  const imgSst = sst(["Chart below"]);
  const imgDrawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

  const workbookImage = makeZip({
    "[Content_Types].xml": contentTypes(1, `<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`),
    "_rels/.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml(["Sheet1"]),
    "xl/_rels/workbook.xml.rels": workbookRels(1),
    "xl/styles.xml": imgStyles,
    "xl/sharedStrings.xml": imgSst,
    "xl/worksheets/sheet1.xml": imgSheet1,
    "xl/worksheets/_rels/sheet1.xml.rels": relsHdr + `<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    "xl/drawings/drawing1.xml": imgDrawing,
    "xl/drawings/_rels/drawing1.xml.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
    "xl/media/image1.png": PNG_BYTES,
  });

  // ---- workbook-financial-a.xlsx / workbook-financial-b.xlsx: reproduces
  // two real defects found via a user report of Excel's repair dialog on
  // a real "Posting Ledger"-style GST/accounting workbook after merging:
  //
  // 1. A currency numFmt whose formatCode needs an XML-escaped literal
  //    quote (e.g. an Indian-Rupee accounting format, "₹"#,##0.00,
  //    which the SOURCE XML writes as formatCode="&quot;₹&quot;#,##0.00").
  //    A naive read-then-re-escape of that attribute double-escapes it
  //    (&quot; becomes &amp;quot;), which Excel decodes back into a
  //    literal "&quot;" string inside the format code - exactly the
  //    "Repaired Records: Format" defect.
  // 2. A shared-formula group (one B-column master cell with the real
  //    formula text + ref, followed by self-closing <f t="shared" si="N"/>
  //    follower cells with no text of their own) on the SAME sheet as an
  //    ordinary, unrelated formula elsewhere - the exact real-world shape
  //    ("SJ-3" ledger running-total columns next to a subtotal formula)
  //    that triggered "Removed Records: Formula" when this workbook's
  //    sheet collided with another file's sheet name and had to be renamed
  //    (only renamed sheets ever get their formulas rewritten).
  //
  // Both fixtures deliberately share sheet names ("Ledger", "Summary") so
  // merging them forces the rename path that exercises both defects.
  function financialStyles(numFmtId) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="${numFmtId}" formatCode="&quot;&#8377;&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Century Gothic"/></font><font><b/><sz val="10"/><name val="Century Gothic"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
  // ledgerSheet: column B is a shared-formula running total (master on
  // row2, self-closing followers rows 3-4); D2 is an UNRELATED standalone
  // formula on the same sheet - the exact mixed shape that corrupted.
  const ledgerSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D4"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData><row r="1" s="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c><c r="D1" t="s" s="1"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><f t="shared" ref="B2:B4" si="0">1400000+A2</f><v>1400000</v></c><c r="D2"><f>SUM(B2:B2)</f><v>1400000</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><f t="shared" si="0"/><v>1446124</v></c></row><row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" s="2"><f t="shared" si="0"/><v>1492372</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;
  const summarySheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>Ledger!B2</f><v>1400000</v></c></row></sheetData></worksheet>`;
  const financialSst = sst(["ERP Document No", "Base Value", "Total", "1", "2", "3"]);

  const workbookFinancialA = makeZip({
    "[Content_Types].xml": contentTypes(2),
    "_rels/.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml(["Ledger", "Summary"]),
    "xl/_rels/workbook.xml.rels": workbookRels(2),
    "xl/styles.xml": financialStyles(164),
    "xl/sharedStrings.xml": financialSst,
    "xl/worksheets/sheet1.xml": ledgerSheet,
    "xl/worksheets/sheet2.xml": summarySheet,
  });
  // workbook-financial-b.xlsx: same sheet names (forces the rename path
  // that exercises rewriteFormulasInWorksheet), a DIFFERENT numFmtId for
  // the same escaped-quote currency format (proves the merge correctly
  // dedupes/remaps id 165 -> a shared merged id, not just id 164 by luck).
  const workbookFinancialB = makeZip({
    "[Content_Types].xml": contentTypes(2),
    "_rels/.rels": relsHdr + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": workbookXml(["Ledger", "Summary"]),
    "xl/_rels/workbook.xml.rels": workbookRels(2),
    "xl/styles.xml": financialStyles(165),
    "xl/sharedStrings.xml": financialSst,
    "xl/worksheets/sheet1.xml": ledgerSheet,
    "xl/worksheets/sheet2.xml": summarySheet,
  });

  return {
    "workbook-a.xlsx": workbookA,
    "workbook-b.xlsx": workbookB,
    "workbook-image.xlsx": workbookImage,
    "workbook-financial-a.xlsx": workbookFinancialA,
    "workbook-financial-b.xlsx": workbookFinancialB,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildFixtures() {
  const files = {
    "valid.pdf": await makePdf(1, "YOYOPDF valid fixture"),
    "multipage.pdf": await makePdf(3, "YOYOPDF multipage fixture"),
    // Phase 12: the only fixture actually large enough to exercise
    // large-document behavior - every other PDF fixture here is 1-3
    // pages, nowhere near YOYO_RESOURCE_LIMITS.maxPdfPages (1500). 250
    // pages is comfortably past the "large document" threshold worth
    // measuring (completion time, memory) while staying well under that
    // ceiling and fast enough to regenerate/check in CI.
    "large.pdf": await makePdf(250, "YOYOPDF large fixture"),
    // Phase 12: the only fixture with a real AcroForm field - needed to
    // test Fill PDF Form's actual field-detection/fill path (every other
    // fixture has zero form fields, which only exercises its "no fillable
    // fields" empty-state message, never the real fill+export behavior).
    "form.pdf": await makeFormPdf(),
    "simple.png": PNG_BYTES,
    // Phase 12 (continuation): 200x150 solid orange, real pixel dimensions
    // large enough that a genuine crop-tool drag measurably shrinks the
    // output - simple.png's 2x2 is too small for that (any crop of it
    // already rounds to <=2px either way).
    "sizable.png": makeSolidPng(200, 150, [0xe8, 0x7a, 0x1a]),
    // Phase 13: left half transparent / right half an opaque gradient,
    // 120x80 - big enough that a real JPEG re-encode reliably comes out
    // smaller than this PNG (see makeTransparentPng's comment), and big
    // enough to sample distinct pixels from each half after re-encoding.
    "transparent.png": makeTransparentPng(120, 80, [0xe8, 0x7a, 0x1a]),
    "malformed.pdf": Buffer.from("%PDF-1.7\nThis is deliberately malformed.\n", "utf8"),
    "empty.bin": Buffer.alloc(0),
  };
  const office = officeFixtures();
  for (const [name, promise] of Object.entries(office)) files[name] = await promise;
  const mergeExcel = mergeExcelFixtures();
  for (const [name, promise] of Object.entries(mergeExcel)) files[name] = await promise;

  const manifest = Object.fromEntries(
    Object.keys(files).sort().map((name) => [
      name,
      { bytes: files[name].length, sha256: sha256(files[name]) },
    ])
  );
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return files;
}

const fixtures = await buildFixtures();
mkdirSync(HERE, { recursive: true });

let failed = false;
for (const [name, expected] of Object.entries(fixtures)) {
  const target = join(HERE, name);
  if (CHECK) {
    if (!existsSync(target) || !readFileSync(target).equals(expected)) {
      console.error("Fixture is missing or stale: " + name);
      failed = true;
    }
  } else {
    writeFileSync(target, expected);
  }
}

if (failed) process.exit(1);
console.log((CHECK ? "Verified " : "Generated ") + Object.keys(fixtures).length + " deterministic fixtures.");
