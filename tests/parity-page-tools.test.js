import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, degrees } from "pdf-lib";

// Parity Wave A: pure helpers in the classic browser scripts, loaded into
// vm sandboxes exactly as shipped (same pattern as
// tests/pdf-to-excel.test.js). DOM-dependent tool handlers are NOT
// exercised here - only the pure functions the handlers now share, so a
// regression in grouping/token/expansion logic fails here instead of
// silently shipping a wrong file to a user.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let pageTools1;
let pageTools2;
let procUtils;

beforeAll(() => {
  const rgbStub = (r, g, b) => ({ r, g, b });
  pageTools1 = vm.createContext({
    console, TOOLS: {}, rgb: rgbStub,
    StandardFonts: { Helvetica: "Helvetica" },
  });
  vm.runInContext(readFileSync(resolve(ROOT, "js/tools/pdf-page-tools-1.js"), "utf8"), pageTools1, { filename: "pdf-page-tools-1.js" });

  pageTools2 = vm.createContext({
    console, TOOLS: {}, PDFDocument, degrees, rgb: rgbStub,
    StandardFonts: { Helvetica: "Helvetica" },
  });
  vm.runInContext(readFileSync(resolve(ROOT, "js/tools/pdf-page-tools-2.js"), "utf8"), pageTools2, { filename: "pdf-page-tools-2.js" });

  procUtils = vm.createContext({
    console, Blob, Response, DecompressionStream, setTimeout, clearTimeout, URL,
    PDFName,
  });
  vm.runInContext(readFileSync(resolve(ROOT, "js/core/pdf-processing-utils.js"), "utf8"), procUtils, { filename: "pdf-processing-utils.js" });
});

describe("pageNumberText (Add Page Numbers)", () => {
  it("keeps the four presets byte-identical", () => {
    const t = pageTools1.pageNumberText;
    expect(t("n-of-total", 3, 10)).toBe("3 / 10");
    expect(t("n", 3, 10)).toBe("3");
    expect(t("page-n", 3, 10)).toBe("Page 3");
    expect(t("page-n-of-total", 3, 10)).toBe("Page 3 of 10");
    expect(t("bogus-format", 3, 10)).toBe("3 / 10");
  });

  it("expands custom-template tokens {n} {p} {r} {rf}", () => {
    const t = pageTools1.pageNumberText;
    const opts = { customTemplate: "Page {n} of {p}", totalPagesInDoc: 20, rangeTotal: 4, rangeTotalFromFirst: 8 };
    expect(t("custom", 5, 8, opts)).toBe("Page 5 of 20");
    expect(t("custom", 5, 8, { ...opts, customTemplate: "{n}/{r} (last {rf})" })).toBe("5/4 (last 8)");
    expect(t("custom", 5, 8, { ...opts, customTemplate: "{n}-{n}" })).toBe("5-5");
  });

  it("falls back to the default preset on an empty custom template and leaves unknown tokens alone", () => {
    const t = pageTools1.pageNumberText;
    expect(t("custom", 5, 12, { customTemplate: "   " })).toBe("5 / 12");
    expect(t("custom", 5, 12, { customTemplate: "S.{x}" })).toBe("S.{x}");
    // {p} without totalPagesInDoc falls back to the passed total.
    expect(t("custom", 5, 12, { customTemplate: "{p}" })).toBe("12");
  });

  it("validates stamp font names and maps them to CSS stacks", () => {
    expect(pageTools1.pageStampStandardFont("TimesRoman")).toBe("TimesRoman");
    expect(pageTools1.pageStampStandardFont("NotAFont")).toBe("Helvetica");
    expect(pageTools1.pageStampFontCss("Courier")).toContain("Courier");
  });
});

describe("splitPageGroups (Split Pages mode / Extract separate files)", () => {
  it("produces one group per page by default, preserving grid rotations", () => {
    const groups = pageTools1.splitPageGroups([0, 1, 2], new Map([[0, 0], [1, 90], [2, 0]]), false);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toEqual([{ index: 1, rotation: 90 }]);
  });

  it("merges into a single group when mergeOutput is on", () => {
    const groups = pageTools1.splitPageGroups([0, 1, 2], new Map([[0, 0], [1, 90], [2, 270]]), true);
    expect(groups).toEqual([[{ index: 0, rotation: 0 }, { index: 1, rotation: 90 }, { index: 2, rotation: 270 }]]);
  });

  it("drops pages removed from the grid (absent from the rotation map)", () => {
    const groups = pageTools1.splitPageGroups([0, 1, 2], new Map([[0, 0], [2, 0]]), false);
    expect(groups).toEqual([[{ index: 0, rotation: 0 }], [{ index: 2, rotation: 0 }]]);
  });

  it("handles a missing rotation map and an empty selection", () => {
    expect(pageTools1.splitPageGroups([0, 1], null, false)).toEqual([
      [{ index: 0, rotation: 0 }],
      [{ index: 1, rotation: 0 }],
    ]);
    expect(pageTools1.splitPageGroups([], new Map(), false)).toEqual([]);
  });
});

describe("classifyPageOrientation (Rotate filter)", () => {
  it("classifies by effective dimensions, swapping on 90/270 rotation", () => {
    const c = pageTools1.classifyPageOrientation;
    expect(c(612, 792, 0)).toBe("portrait");
    expect(c(792, 612, 0)).toBe("landscape");
    expect(c(612, 792, 90)).toBe("landscape");
    expect(c(792, 612, 90)).toBe("portrait");
    expect(c(612, 792, 180)).toBe("portrait");
    expect(c(612, 792, 270)).toBe("landscape");
    expect(c(500, 500, 0)).toBe("portrait");
  });
});

describe("expandHeaderFooterTokens (Header & Footer)", () => {
  it("expands {n} {p} {date} and leaves unknown tokens alone", () => {
    const f = pageTools2.expandHeaderFooterTokens;
    expect(f("Page {n} of {p} — {date}", 3, 10, "01/01/2026")).toBe("Page 3 of 10 — 01/01/2026");
    expect(f("Confidential {x}", 1, 5, "today")).toBe("Confidential {x}");
    expect(f("No tokens", 1, 5, "today")).toBe("No tokens");
    expect(f("", 1, 5, "today")).toBe("");
  });
});

describe("buildOrganizedPdf (Organize blank-page export)", () => {
  // The shipped function source is evaluated in THIS realm (not the vm
  // sandbox): pdf-lib's validators use `instanceof Array`, which rejects
  // arrays created inside a vm context ("must be of type Array, but was
  // actually of type Array"). In the browser there is only one realm, so
  // this is purely a harness limitation - the source under test is the
  // exact text from js/tools/pdf-page-tools-2.js, sliced out verbatim.
  let buildOrganizedPdf;
  beforeAll(() => {
    const src = readFileSync(resolve(ROOT, "js/tools/pdf-page-tools-2.js"), "utf8");
    const start = src.indexOf("async function buildOrganizedPdf");
    const end = src.indexOf("TOOLS.organize", start);
    const fnSrc = src.slice(start, end);
    buildOrganizedPdf = new Function("PDFDocument", "degrees", `${fnSrc}; return buildOrganizedPdf;`)(PDFDocument, degrees);
  });

  async function makePdf(nPages) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < nPages; i++) doc.addPage();
    return doc;
  }

  it("interleaves real pages and blank pages in grid order", async () => {
    const docA = await makePdf(2);
    const docB = await makePdf(1);
    const out = await buildOrganizedPdf([docA, docB], [
      { index: 0, rotation: 0, docIndex: 0 },
      { blank: true, width: 100, height: 200, rotation: 0 },
      { index: 0, rotation: 0, docIndex: 1 },
      { index: 1, rotation: 90, docIndex: 0 },
    ]);
    expect(out.getPageCount()).toBe(4);
    const sizes = out.getPages().map((p) => p.getSize());
    expect(sizes[1].width).toBe(100);
    expect(sizes[1].height).toBe(200);
    expect(sizes[0].width).toBeCloseTo(595.28, 1);
    expect(out.getPages()[3].getRotation().angle).toBe(90);
  });

  it("handles an all-blank spec", async () => {
    const out = await buildOrganizedPdf([], [
      { blank: true, width: 595, height: 842, rotation: 0 },
    ]);
    expect(out.getPageCount()).toBe(1);
  });
});

describe("compress pixel expansion (pdf-processing-utils)", () => {
  it("expands palette-index pixels through an RGB lookup", () => {
    const rgba = procUtils.indexedPixelsToRgba(
      new Uint8Array([0, 1]),
      2, 1,
      new Uint8Array([255, 0, 0, 0, 0, 255]),
      3,
    );
    expect([...rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("expands palette-index pixels through a Gray lookup", () => {
    const rgba = procUtils.indexedPixelsToRgba(
      new Uint8Array([0, 1]),
      2, 1,
      new Uint8Array([0, 255]),
      1,
    );
    expect([...rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it("converts CMYK with the standard simple transform", () => {
    const rgba = procUtils.cmykPixelsToRgba(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0]),
      3, 1,
    );
    // white, black, cyan
    expect([...rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255]);
  });

  it("overwrites only the alpha channel when applying a soft mask", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    procUtils.applySmaskToRgba(rgba, new Uint8Array([0, 128]));
    expect([...rgba]).toEqual([10, 20, 30, 0, 40, 50, 60, 128]);
  });

  it("resolves an Indexed colour space from a direct string lookup", () => {
    const fakeName = (s) => ({ asString: () => s });
    const fakeNum = (n) => ({ asNumber: () => n });
    const cs = {
      array: [
        fakeName("/Indexed"),
        fakeName("/DeviceRGB"),
        fakeNum(1),
        { asBytes: () => new Uint8Array([255, 0, 0, 0, 255, 0]) },
      ],
    };
    const info = procUtils.resolveIndexedColorSpace(cs, null, PDFName);
    expect(info).not.toBeNull();
    expect(info.baseComponents).toBe(3);
    expect(info.hival).toBe(1);
    expect([...info.lookup]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("rejects Indexed spaces with a short lookup or unknown base", () => {
    const fakeName = (s) => ({ asString: () => s });
    const fakeNum = (n) => ({ asNumber: () => n });
    const short = {
      array: [fakeName("/Indexed"), fakeName("/DeviceRGB"), fakeNum(5), { asBytes: () => new Uint8Array([1, 2]) }],
    };
    expect(procUtils.resolveIndexedColorSpace(short, null, PDFName)).toBeNull();
    const badBase = {
      array: [fakeName("/Indexed"), fakeName("/Lab"), fakeNum(0), { asBytes: () => new Uint8Array([1, 2, 3]) }],
    };
    expect(procUtils.resolveIndexedColorSpace(badBase, null, PDFName)).toBeNull();
    expect(procUtils.resolveIndexedColorSpace({ asString: () => "/DeviceRGB" }, null, PDFName)).toBeNull();
  });

  it("decodes a same-size 8-bit Flate soft mask and rejects mismatches", async () => {
    const maskBytes = deflateSync(new Uint8Array([0, 128, 255, 64]));
    const fakeName = (s) => ({ asString: () => s });
    const fakeNum = (n) => ({ asNumber: () => n });
    const fields = {
      "/Width": fakeNum(2),
      "/Height": fakeNum(2),
      "/BitsPerComponent": fakeNum(8),
      "/Filter": fakeName("/FlateDecode"),
      "/Decode": undefined,
      "/DecodeParms": undefined,
    };
    const maskObj = {
      dict: { lookup: (k) => fields[k.toString()] },
      contents: new Uint8Array(maskBytes),
    };
    const alpha = await procUtils.decodeSmaskAlpha(maskObj, null, PDFName, 2, 2);
    expect(alpha).not.toBeNull();
    expect([...alpha]).toEqual([0, 128, 255, 64]);
    // Wrong dimensions -> null (never resampled/guessed).
    expect(await procUtils.decodeSmaskAlpha(maskObj, null, PDFName, 3, 3)).toBeNull();
  });

  it("reports only non-zero skip reasons, in fixed order", () => {
    const stats = {
      skipped: { unsupportedFilter: 0, alpha: 2, masked: 0, decode: 0, colorSpace: 1, unsupportedParams: 0, error: 3 },
    };
    expect(procUtils.compressSkipBreakdown(stats)).toEqual([
      { key: "toolCompress.skipAlpha", count: 2 },
      { key: "toolCompress.skipColorSpace", count: 1 },
      { key: "toolCompress.skipError", count: 3 },
    ]);
    expect(procUtils.compressSkipBreakdown({})).toEqual([]);
    expect(procUtils.compressSkipBreakdown(null)).toEqual([]);
  });
});
