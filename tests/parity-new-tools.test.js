import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import * as PDFLib from "pdf-lib";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import XLSX from "xlsx";
import JSZip from "jszip";

// Wave D parity tests. js/tools/pdf-extra-tools.js and js/tools/image-tools.js
// are classic (non-module) browser scripts, loaded into vm sandboxes the
// same way tests/pdf-to-excel.test.js loads js/core/doc-export-builders.js.
// Only the DOM-free pure helpers are exercised here; the panel openers are
// checked for registration only (TOOLS.<id> must be a function).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let extra;
let builders;
let imgs;

beforeAll(() => {
  const extraSrc = readFileSync(resolve(ROOT, "js/tools/pdf-extra-tools.js"), "utf8");
  extra = vm.createContext({ console, TOOLS: {}, PDFLib, pdfjsLib, JSZip, setTimeout, clearTimeout });
  vm.runInContext(extraSrc, extra, { filename: "pdf-extra-tools.js" });

  const buildersSrc = readFileSync(resolve(ROOT, "js/core/doc-export-builders.js"), "utf8");
  builders = vm.createContext({ console, pdfjsLib, XLSX, JSZip });
  vm.runInContext(buildersSrc, builders, { filename: "doc-export-builders.js" });

  const imgSrc = readFileSync(resolve(ROOT, "js/tools/image-tools.js"), "utf8");
  imgs = vm.createContext({
    console,
    TOOLS: {},
    YOYO_RESOURCE_LIMITS: { maxImageDimension: 16384, maxImagePixels: 64000000 },
  });
  vm.runInContext(imgSrc, imgs, { filename: "image-tools.js" });
});

async function textFixturePdf() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Hello world", { x: 72, y: 700, size: 14, font: helv, color: rgb(0, 0, 0) });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("one two three four", { x: 72, y: 700, size: 14, font: helv, color: rgb(0, 0, 0) });
  return doc.save();
}

async function pageTexts(pdfBytes) {
  const pdoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const out = [];
  for (let i = 1; i <= pdoc.numPages; i++) {
    const page = await pdoc.getPage(i);
    const tc = await page.getTextContent();
    out.push(extra.pageTextFromItems(tc.items));
  }
  await pdoc.destroy();
  return out;
}

describe("PDF Counter counts (countWordsAndChars / readingMinutes / pageTextFromItems)", () => {
  it("counts words, characters and no-space characters", () => {
    const c = extra.countWordsAndChars("Hello   world\nnew line");
    expect(c.words).toBe(4);
    expect(c.chars).toBe("Hello   world\nnew line".length);
    expect(c.charsNoSpaces).toBe("Helloworldnewline".length);
    expect(extra.countWordsAndChars("")).toEqual({ words: 0, chars: 0, charsNoSpaces: 0 });
  });

  it("counts Devanagari words the same way as Latin", () => {
    expect(extra.countWordsAndChars("नमस्ते दुनिया test").words).toBe(3);
    expect(extra.countWordsAndChars("लखनऊ में आज बारिश").words).toBe(4);
  });

  it("reading time is 0 for scanned/empty pages and ~200wpm otherwise", () => {
    expect(extra.readingMinutes(0)).toBe(0);
    expect(extra.readingMinutes(1)).toBe(1);
    expect(extra.readingMinutes(200)).toBe(1);
    expect(extra.readingMinutes(201)).toBe(2);
    expect(extra.readingMinutes(1000)).toBe(5);
  });

  it("pageTextFromItems inserts a space only on a real geometry gap", () => {
    const items = [
      { str: "Hello", transform: [11, 0, 0, 11, 72, 700], width: 30, hasEOL: false },
      { str: "world", transform: [11, 0, 0, 11, 106, 700], width: 30, hasEOL: false },
    ];
    expect(extra.pageTextFromItems(items)).toBe("Hello world");
    const tight = [
      { str: "Hello", transform: [11, 0, 0, 11, 72, 700], width: 30, hasEOL: false },
      { str: "world", transform: [11, 0, 0, 11, 103, 700], width: 30, hasEOL: false },
    ];
    expect(extra.pageTextFromItems(tight)).toBe("Helloworld");
  });

  it("pageTextFromItems honours hasEOL newlines", () => {
    const items = [
      { str: "first", transform: [11, 0, 0, 11, 72, 700], width: 30, hasEOL: true },
      { str: "second", transform: [11, 0, 0, 11, 72, 680], width: 30, hasEOL: false },
    ];
    expect(extra.pageTextFromItems(items)).toBe("first\nsecond");
  });

  it("counts real text from a fixture PDF end to end", async () => {
    const texts = await pageTexts(await textFixturePdf());
    expect(texts).toHaveLength(2);
    const totals = texts.reduce(
      (acc, t) => {
        const c = extra.countWordsAndChars(t);
        acc.words += c.words; acc.chars += c.chars; acc.charsNoSpaces += c.charsNoSpaces;
        return acc;
      },
      { words: 0, chars: 0, charsNoSpaces: 0 },
    );
    expect(totals.words).toBe(6);
    expect(totals.chars).toBe(29);
    expect(totals.charsNoSpaces).toBe(25);
    expect(extra.readingMinutes(totals.words)).toBe(1);
  });
});

describe("Compare PDF word diff (diffWordTokens / diffSummarize)", () => {
  it("marks added, removed and unchanged words", () => {
    const ops = extra.diffWordTokens(
      ["the", "quick", "brown"],
      ["the", "slow", "brown"],
    );
    expect(ops).toEqual([
      { op: "=", text: "the" },
      { op: "-", text: "quick" },
      { op: "+", text: "slow" },
      { op: "=", text: "brown" },
    ]);
    expect(extra.diffSummarize(ops)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it("diffs against an empty page as a pure insertion", () => {
    expect(extra.diffWordTokens([], ["a", "b"])).toEqual([{ op: "+", text: "a b" }]);
    expect(extra.diffWordTokens(["a"], [])).toEqual([{ op: "-", text: "a" }]);
    expect(extra.diffWordTokens(["same"], ["same"])).toEqual([{ op: "=", text: "same" }]);
  });

  it("falls back to a whole-page replace for huge token products", () => {
    const big = Array(700).fill("x");
    const ops = extra.diffWordTokens(big, Array(700).fill("y"));
    expect(ops).toHaveLength(2);
    expect(extra.diffSummarize(ops)).toEqual({ added: 700, removed: 700, unchanged: 0 });
    const same = extra.diffWordTokens(big, [...big]);
    expect(same).toEqual([{ op: "=", text: big.join(" ") }]);
  });
});

describe("PDF to Markdown (blocksToMarkdown)", () => {
  function para(text, size, bold) {
    return { type: "paragraph", runs: [{ text, size, bold: !!bold }] };
  }

  it("emits ATX headings from bold + relative size, tables, lists and separators", () => {
    const blocks = [
      para("Annual Report", 24, true),
      para("Section", 17, true),
      para("Note", 13, true),
      para("Revenue grew this year.", 11, false),
      para("Second body line.", 11, false),
      para("Third body line.", 11, false),
      para("First item", 11, false),
      { type: "table", rows: [["Name", "Age"], ["Asha", "30"], ["Ravi", "41"]] },
      {
        type: "gridtable", nRows: 2, nCols: 3,
        cells: [
          { r0: 0, c0: 0, text: "Q1" }, { r0: 0, c0: 1, text: "Q2" },
          { r0: 1, c0: 0, text: "10" }, { r0: 1, c0: 1, text: "20" }, { r0: 1, c0: 2, text: "30" },
        ],
      },
      { type: "separator" },
      { type: "columns", left: [para("Left col", 11, false)], right: [para("Right col", 11, false)] },
    ];
    // List item flag lives on the paragraph itself.
    blocks[6].listItem = true;
    const md = extra.blocksToMarkdown(blocks);
    expect(md).toContain("# Annual Report");
    expect(md).toContain("## Section");
    expect(md).toContain("### Note");
    expect(md).toContain("Revenue grew this year.");
    expect(md).toContain("- First item");
    expect(md).toContain("| Name | Age |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Asha | 30 |");
    // Spanned/missing grid cell becomes an empty cell so columns stay aligned.
    expect(md).toContain("| Q1 | Q2 |  |");
    expect(md).toContain("| 10 | 20 | 30 |");
    expect(md).toContain("---");
    expect(md.indexOf("Left col")).toBeLessThan(md.indexOf("Right col"));
  });

  it("converts a real extracted page: bold heading + body text", async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText("Annual Report", { x: 72, y: 700, size: 24, font: bold, color: rgb(0, 0, 0) });
    page.drawText("Revenue grew this year.", { x: 72, y: 660, size: 11, font: helv, color: rgb(0, 0, 0) });
    page.drawText("Costs stayed flat.", { x: 72, y: 640, size: 11, font: helv, color: rgb(0, 0, 0) });
    const bytes = await doc.save();
    const pdoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const visuals = await builders.extractPageVisuals(pdoc, 1);
    const blocks = await builders.extractPageBlocks(pdoc, 1, visuals);
    const md = extra.blocksToMarkdown(blocks);
    await pdoc.destroy();
    expect(md).toContain("Annual Report");
    expect(md).toContain("Revenue grew this year.");
    expect(md).toContain("Costs stayed flat.");
  });
});

describe("Edit PDF Metadata (readPdfMetadata / applyPdfMetadata round-trip)", () => {
  // pdf-lib validates setKeywords/setCreationDate with `instanceof
  // Array/Date`, which fails for values created inside the vm sandbox
  // realm even though the browser has a single realm and the shipped
  // code is correct there. So the mapping logic is tested against a
  // duck-typed stub doc (getters return sandbox-realm Dates, which is
  // what readPdfMetadata's instanceof check sees in the sandbox), and
  // pdf-lib persistence is verified separately in the main realm.
  function stubDoc(values) {
    const sets = {};
    const doc = {
      setTitle: (v) => { sets.title = v; },
      setAuthor: (v) => { sets.author = v; },
      setSubject: (v) => { sets.subject = v; },
      setKeywords: (v) => { sets.keywords = v; },
      setCreator: (v) => { sets.creator = v; },
      setProducer: (v) => { sets.producer = v; },
      setCreationDate: (v) => { sets.creationDate = v; },
      setModificationDate: (v) => { sets.modificationDate = v; },
      getTitle: () => values.title,
      getAuthor: () => values.author,
      getSubject: () => values.subject,
      getKeywords: () => values.keywords,
      getCreator: () => values.creator,
      getProducer: () => values.producer,
      getCreationDate: () => values.creationDate,
      getModificationDate: () => values.modificationDate,
    };
    return { doc, sets };
  }

  it("maps fields, splits keywords and passes dates through", () => {
    const created = vm.runInContext('new Date("2020-01-02T03:04:05Z")', extra);
    const modified = vm.runInContext('new Date("2021-06-07T08:09:10Z")', extra);
    const { doc, sets } = stubDoc({});
    extra.applyPdfMetadata(doc, {
      title: "Test Title",
      author: "Asha",
      subject: "Quarterly",
      keywords: "alpha, beta , gamma",
      creator: "YOYOPDF",
      producer: "pdf-lib",
      creationDate: created,
      modificationDate: modified,
    }, false);
    expect(sets.title).toBe("Test Title");
    expect(sets.author).toBe("Asha");
    expect(sets.subject).toBe("Quarterly");
    expect(sets.keywords).toEqual(["alpha", "beta", "gamma"]);
    expect(sets.creator).toBe("YOYOPDF");
    expect(sets.producer).toBe("pdf-lib");
    expect(sets.creationDate).toBe(created);
    expect(sets.modificationDate).toBe(modified);
  });

  it("clear-all blanks strings and resets dates to the epoch", () => {
    const { doc, sets } = stubDoc({});
    extra.applyPdfMetadata(doc, {}, true);
    expect(sets.title).toBe("");
    expect(sets.author).toBe("");
    expect(sets.subject).toBe("");
    expect(sets.keywords).toEqual([]);
    expect(sets.creator).toBe("");
    expect(sets.producer).toBe("");
    expect(sets.creationDate.getTime()).toBe(0);
    expect(sets.modificationDate.getTime()).toBe(0);
  });

  it("reads fields back, joining keywords and keeping dates", () => {
    const created = vm.runInContext('new Date("2020-01-02T03:04:05Z")', extra);
    const { doc } = stubDoc({
      title: "Test Title", author: "Asha", subject: "Quarterly",
      keywords: ["alpha", "beta", "gamma"], creator: "YOYOPDF", producer: "pdf-lib",
      creationDate: created, modificationDate: null,
    });
    const meta = extra.readPdfMetadata(doc);
    expect(meta.title).toBe("Test Title");
    expect(meta.keywords).toBe("alpha, beta, gamma");
    expect(meta.creationDate.getTime()).toBe(created.getTime());
    expect(meta.modificationDate).toBeNull();
  });

  it("pdf-lib persists the same values across save/reload (main realm)", async () => {
    const doc = await PDFDocument.create();
    doc.setTitle("Test Title");
    doc.setAuthor("Asha");
    doc.setKeywords(["alpha", "beta", "gamma"]);
    doc.setCreationDate(new Date("2020-01-02T03:04:05Z"));
    const reloaded = await PDFDocument.load(await doc.save());
    expect(reloaded.getTitle()).toBe("Test Title");
    expect(reloaded.getAuthor()).toBe("Asha");
    // pdf-lib stores keywords space-joined and getKeywords returns the
    // joined string, not an array.
    expect(reloaded.getKeywords()).toBe("alpha beta gamma");
    expect(reloaded.getCreationDate().getTime()).toBe(new Date("2020-01-02T03:04:05Z").getTime());
  });
});

describe("Resize Page Size (resizePdfPageSize / resizePageGeometry)", () => {
  it("exposes the A4/Letter/Legal presets in points", () => {
    // const bindings are not properties of the vm context object;
    // read them by evaluating inside the sandbox realm.
    const presets = vm.runInContext("PAGE_SIZE_PRESETS_PT", extra);
    expect(presets.a4).toEqual([595.28, 841.89]);
    expect(presets.letter).toEqual([612, 792]);
    expect(presets.legal).toEqual([612, 1008]);
  });

  it("fit/fill/stretch/center geometry", () => {
    const fit = extra.resizePageGeometry(612, 792, 595.28, 841.89, "fit");
    expect(fit.x).toBeCloseTo(0, 5);
    expect(fit.width).toBeCloseTo(595.28, 2);
    expect(fit.height).toBeCloseTo(770.36, 1);
    const fill = extra.resizePageGeometry(612, 792, 595.28, 841.89, "fill");
    expect(fill.height).toBeCloseTo(841.89, 2);
    expect(fill.x).toBeLessThan(0);
    const stretch = extra.resizePageGeometry(612, 792, 595.28, 841.89, "stretch");
    expect(stretch).toEqual({ x: 0, y: 0, width: 595.28, height: 841.89 });
    const center = extra.resizePageGeometry(300, 400, 595.28, 841.89, "center");
    expect(center.width).toBe(300);
    expect(center.x).toBeCloseTo(147.64, 2);
  });

  it("rebuilds every page at the target size, text intact", async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([612, 792]);
    p1.drawText("Hello world", { x: 72, y: 700, size: 14, font: helv });
    // Second page is deliberately blank: pdf-lib refuses to embed
    // pages with no Contents entry, and the resize must survive it.
    doc.addPage([300, 400]);
    // resizePdfPageSize builds an indices array ([i]) inside its own
    // realm for dst.embedPdf, and pdf-lib validates it with
    // `instanceof Array` — a vm-sandbox array fails that check even
    // though the browser's single realm is fine. So evaluate the
    // exact shipped source of resizePageGeometry + resizePdfPageSize
    // in the main realm here; the pure-geometry tests above already
    // cover the same functions inside the sandbox.
    const src = readFileSync(resolve(ROOT, "js/tools/pdf-extra-tools.js"), "utf8");
    const chunk = src.slice(
      src.indexOf("function resizePageGeometry"),
      src.indexOf("/* Pure geometry for Scan to PDF"),
    );
    const resizePdfPageSizeMain = new Function("PDFLib", chunk + "\nreturn resizePdfPageSize;")(PDFLib);
    const out = await resizePdfPageSizeMain(await doc.save(), {
      size: [595.28, 841.89],
      mode: "fit",
    });
    const resized = await PDFDocument.load(out);
    expect(resized.getPageCount()).toBe(2);
    for (const page of resized.getPages()) {
      const s = page.getSize();
      expect(s.width).toBeCloseTo(595.28, 2);
      expect(s.height).toBeCloseTo(841.89, 2);
    }
    const texts = await pageTexts(out);
    expect(texts[0]).toContain("Hello world");
  });

  it("fitImageIntoPage centres an image inside the page box with margin", () => {
    const g = extra.fitImageIntoPage(800, 600, 595.28, 841.89, 36);
    expect(g.width).toBeCloseTo(523.28, 2);
    expect(g.height).toBeCloseTo(392.46, 1);
    expect(g.x).toBeCloseTo(36, 5);
    expect(g.y).toBeCloseTo(224.7, 1);
  });
});

describe("Extract Images (imageDedupeKey / extractImagesFromVisuals)", () => {
  it("dedupes the same raw image and keeps distinct ones", () => {
    const raw = { width: 10, height: 10, data: new Uint8Array([1, 2, 3, 4]) };
    const other = { width: 10, height: 10, data: new Uint8Array([9, 8, 7, 6]) };
    const visuals = { images: [
      { raw, x: 0, y: 0 },
      { raw: { width: 10, height: 10, data: new Uint8Array([1, 2, 3, 4]) }, x: 0, y: 100 },
      { raw: other, x: 0, y: 200 },
      { x: 0, y: 0 },
    ] };
    const found = extra.extractImagesFromVisuals(visuals);
    expect(found).toHaveLength(2);
    expect(found[0].width).toBe(10);
    expect(extra.imageDedupeKey(raw)).toBe(extra.imageDedupeKey({ width: 10, height: 10, data: new Uint8Array([1, 2, 3, 4]) }));
  });

  it("one embedded PNG drawn on two pages extracts once, on both pages", async () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pngBytes = Uint8Array.from(Buffer.from(pngBase64, "base64"));
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(pngBytes);
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([612, 792]);
      page.drawImage(img, { x: 72, y: 700, width: 100, height: 100 });
    }
    const bytes = await doc.save();
    const pdoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const all = [];
    for (let i = 1; i <= pdoc.numPages; i++) {
      // The local enumerator resolves shared XObjects via page.objs
      // AND page.commonObjs; the shared extractPageVisuals path
      // silently drops the image on every page after the first.
      const found = await extra.extraExtractPageImages(pdoc, i);
      expect(found).toHaveLength(1);
      all.push(...found);
    }
    await pdoc.destroy();
    expect(extra.extractImagesFromVisuals({ images: all })).toHaveLength(1);
  });
});

describe("Image batch helpers (imgBatchPlan / imgResizeDimensions / crop / rotate / watermark)", () => {
  it("caps batches at 30, matching the iLoveIMG free tier", () => {
    const limit = vm.runInContext("IMG_BATCH_LIMIT", imgs);
    expect(limit).toBe(30);
    const files = Array.from({ length: 35 }, (_, i) => ({ name: `f${i}.png` }));
    const plan = imgs.imgBatchPlan(files, limit);
    expect(plan.kept).toHaveLength(30);
    expect(plan.dropped).toBe(5);
    const small = imgs.imgBatchPlan([{ name: "a.png" }], limit);
    expect(small.kept).toHaveLength(1);
    expect(small.dropped).toBe(0);
  });

  it("resize dimensions for percent, fit-within (never upscale) and exact", () => {
    expect(imgs.imgResizeDimensions(800, 600, "percent", { percent: 50 })).toEqual({ w: 400, h: 300 });
    expect(imgs.imgResizeDimensions(800, 600, "percent", { percent: 1 })).toEqual({ w: 8, h: 6 });
    // 0% is falsy and falls back to 100% in the shipped helper.
    expect(imgs.imgResizeDimensions(800, 600, "percent", { percent: 0 })).toEqual({ w: 800, h: 600 });
    expect(imgs.imgResizeDimensions(800, 600, "fit", { maxW: 400, maxH: 400 })).toEqual({ w: 400, h: 300 });
    expect(imgs.imgResizeDimensions(800, 600, "fit", { maxW: 2000, maxH: 2000 })).toEqual({ w: 800, h: 600 });
    expect(imgs.imgResizeDimensions(800, 600, "exact", { w: 100, h: 50 })).toEqual({ w: 100, h: 50 });
  });

  it("centre-crops to the target aspect ratio", () => {
    expect(imgs.cropRectForAspect(800, 600, 16 / 9)).toEqual({ sx: 0, sy: 75, sw: 800, sh: 450 });
    expect(imgs.cropRectForAspect(800, 600, 3 / 4)).toEqual({ sx: 175, sy: 0, sw: 450, sh: 600 });
    expect(imgs.cropRectForAspect(800, 600, 1)).toEqual({ sx: 100, sy: 0, sw: 600, sh: 600 });
  });

  it("rotation canvas swaps axes at 90 degrees and bounds arbitrary angles", () => {
    expect(imgs.rotateCanvasDimensions(800, 600, 90)).toEqual({ w: 600, h: 800 });
    expect(imgs.rotateCanvasDimensions(800, 600, 270)).toEqual({ w: 600, h: 800 });
    expect(imgs.rotateCanvasDimensions(800, 600, 180)).toEqual({ w: 800, h: 600 });
    expect(imgs.rotateCanvasDimensions(800, 600, 45)).toEqual({ w: 990, h: 990 });
  });

  it("watermark anchor covers all nine positions with margin", () => {
    expect(imgs.watermarkAnchor(800, 600, 200, 100, "top-left", 20)).toEqual({ x: 20, y: 20 });
    expect(imgs.watermarkAnchor(800, 600, 200, 100, "bottom-right", 20)).toEqual({ x: 580, y: 480 });
    expect(imgs.watermarkAnchor(800, 600, 200, 100, "center", 20)).toEqual({ x: 300, y: 250 });
    expect(imgs.watermarkAnchor(800, 600, 200, 100, "top-center", 20)).toEqual({ x: 300, y: 20 });
    expect(imgs.watermarkAnchor(800, 600, 200, 100, "middle-right", 0)).toEqual({ x: 600, y: 250 });
  });

  it("runImageBatch processes sequentially, skipping failures without aborting", async () => {
    const order = [];
    const { results, failures } = await imgs.runImageBatch(
      ["a", "b", "c"],
      async (f) => {
        order.push(f);
        if (f === "b") throw new Error("decode failed");
        return { blob: f };
      },
    );
    expect(order).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.blob)).toEqual(["a", "c"]);
    expect(failures).toHaveLength(1);
  });
});

describe("Wave D tool registration", () => {
  it("registers all nine new tools as panel openers", () => {
    for (const id of ["pdfcounter", "extractimages", "extracttext", "pdfmetadata", "pdf2md", "resizepages", "comparepdf", "scantopdf"]) {
      expect(typeof extra.TOOLS[id]).toBe("function");
    }
    expect(typeof extra.TOOLS.imgrotate).toBe("undefined");
  });

  it("registers Rotate Image and the six batch tools in image-tools.js", () => {
    for (const id of ["imgcompress", "imgresize", "imgcrop", "imgconvert", "imgwatermark", "imginvert", "imgrotate"]) {
      expect(typeof imgs.TOOLS[id]).toBe("function");
    }
  });
});
