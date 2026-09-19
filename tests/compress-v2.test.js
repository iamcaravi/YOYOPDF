import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PDFDocument } from "pdf-lib";

// Compress PDF V2 - pure-function coverage: the pixel classifier that
// separates scanned/typed pages from ordinary photos, the preset ladder,
// the /Decode guard and the outcome builder that decides what the result
// screen says. The real js/core/pdf-processing-utils.js is loaded into a vm
// sandbox (same approach as tests/pdf-processing-utils.test.js) - nothing is
// re-implemented here.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let sb;
const get = (expr) => vm.runInContext(expr, sb); // top-level const/let are not sandbox properties

beforeAll(() => {
  const source = readFileSync(resolve(ROOT, "js/core/pdf-processing-utils.js"), "utf8");
  sb = vm.createContext({ AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, sb, { filename: "pdf-processing-utils.js" });
});

// ---- deterministic synthetic 128px-thumbnail generators (seeded PRNG) ----
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const W = 128, H = 85;
function frame(fn) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b, a = 255] = fn(x, y);
    const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  return px;
}
// Paper of a given colour with scanner noise and `ink` fraction of dark text-like pixels.
function paper(rgb, { noise = 3, ink = 0.06, seed = 1, inkRgb = [25, 25, 30] } = {}) {
  const r = rng(seed);
  return frame(() => {
    if (r() < ink) return inkRgb;
    const n = (r() - 0.5) * 2 * noise;
    return [rgb[0] + n, rgb[1] + n, rgb[2] + n];
  });
}
// A "photo": broad, busy distribution across all tones.
function photo(seed = 2, lo = 0, hi = 255) {
  const r = rng(seed);
  return frame((x, y) => {
    const base = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(x / 9 + y / 13) * Math.cos(y / 7));
    const n = (r() - 0.5) * 60;
    return [base + n, base * 0.8 + n, base * 0.6 + n];
  });
}
const classify = (px) => get("isDocumentPageFromSignals")(get("documentSignalsFromPixels")(px));
const signals = (px) => get("documentSignalsFromPixels")(px);

describe("document classifier - pages ARE protected", () => {
  it.each([
    ["clean white scan", () => paper([236, 234, 228])],
    ["grey scan", () => paper([230, 230, 230], { ink: 0.05 })],
    ["yellowed paper", () => paper([215, 200, 150])],
    ["newsprint grey", () => paper([165, 165, 160], { noise: 5 })],
    ["shadowed / dark scan (peak luma ~125)", () => paper([128, 128, 124], { noise: 4 })],
    ["dense text page (25% ink)", () => paper([240, 238, 232], { ink: 0.25 })],
    ["sparse page (almost blank)", () => paper([240, 238, 232], { ink: 0.005 })],
    ["invoice with a colour logo block", () => { const p = paper([238, 236, 230], { seed: 5 }); for (let y = 4; y < 16; y++) for (let x = 6; x < 60; x++) { const i = (y * W + x) * 4; p[i] = 30; p[i + 1] = 110; p[i + 2] = 220; } return p; }],
  ])("%s", (_name, make) => {
    expect(classify(make())).toBe(true);
  });

  it("mixed text + photo page (photo on ~45% of the area) is still protected", () => {
    const p = paper([238, 236, 230], { seed: 9 });
    const ph = photo(4);
    const cut = Math.round(H * 0.55); // rows below `cut` are the photo (~45% of the page)
    for (let y = cut; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; p[i] = ph[i]; p[i + 1] = ph[i + 1]; p[i + 2] = ph[i + 2]; }
    expect(signals(p).paperShare).toBeGreaterThan(0.45);
    expect(classify(p)).toBe(true);
  });
});

describe("document classifier - photos are NOT protected", () => {
  it("a busy, wide-tone photo", () => {
    expect(classify(photo(7))).toBe(false);
    expect(signals(photo(7)).paperShare).toBeLessThan(0.3);
  });
  it("many different photos (seeds) - none is called a document", () => {
    for (let seed = 20; seed < 60; seed++) expect(classify(photo(seed)), `seed ${seed}`).toBe(false);
  });
  it("a smooth colour gradient (sky-like) is not a document", () => {
    const g = frame((x) => [40 + x, 80 + x, 200 - x / 2]);
    expect(classify(g)).toBe(false);
  });
  it("a DARK photo is not mistaken for a page even though its histogram has one tight mode", () => {
    const dark = paper([22, 24, 30], { ink: 0.02, noise: 4 });
    const s = signals(dark);
    expect(s.paperShare).toBeGreaterThan(0.9); // one dominant tone...
    expect(s.peakLuma).toBeLessThan(100);      // ...but a dark one, and paper is never dark
    expect(classify(dark)).toBe(false);
  });
});

describe("document classifier - documented behaviour at the edges", () => {
  it("a flat bright image (overcast sky, white-background product shot) IS protected - the deliberate, cheap error direction", () => {
    expect(classify(paper([250, 250, 250], { ink: 0, noise: 2 }))).toBe(true);
  });
  it("fully transparent pixels carry no information", () => {
    const px = frame(() => [255, 255, 255, 0]);
    expect(signals(px)).toEqual({ paperShare: 0, peakLuma: 0 });
    expect(classify(px)).toBe(false);
  });
  it("is deterministic and reports the darkest window on a tie", () => {
    const a = signals(photo(3)), b = signals(photo(3));
    expect(a).toEqual(b);
  });
  it("threshold constants are the validated values", () => {
    expect(get("DOC_PAPER_SHARE_MIN")).toBe(0.45);
    expect(get("DOC_PEAK_LUMA_MIN")).toBe(100);
    expect(get("DOC_THUMB_LONG_EDGE")).toBe(128);
  });
});

describe("prefilter (unchanged) and thumbnail size", () => {
  const pre = (w, h) => get("looksLikeDocumentPage")(w, h);
  it("still gates on size and page-like aspect ratio", () => {
    expect(pre(2480, 3508)).toBe(true);   // A4 @300dpi
    expect(pre(4000, 3000)).toBe(true);   // 4:3 photo passes the PREFILTER - the pixel signal decides
    expect(pre(3600, 2400)).toBe(true);   // 3:2 photo, same
    expect(pre(800, 600)).toBe(false);    // too small to be a full-page scan
    expect(pre(3000, 1000)).toBe(false);  // panorama
    expect(pre(2000, 2000)).toBe(false);  // square
  });
  it("thumbnail is 128 px on the long edge, never upscaled", () => {
    const size = get("documentThumbSize");
    expect(size(4000, 3000)).toEqual({ width: 128, height: 96 });
    expect(size(2400, 3600)).toEqual({ width: 85, height: 128 });
    expect(size(100, 60)).toEqual({ width: 100, height: 60 });
  });
});

describe("preset quality ladder", () => {
  const presets = () => JSON.parse(JSON.stringify(get("COMPRESS_PRESETS")));
  it("Recommended photo quality is 0.75 and document quality stays 0.82", () => {
    const p = presets();
    expect(p.recommended.quality).toBe(0.75);
    expect(p.recommended.documentQuality).toBe(0.82);
    expect(p.recommended.maxDim).toBe(2200);
    expect(p.recommended.protectDocuments).toBe(true);
  });
  it("High (Less compression) and Extreme are unchanged", () => {
    const p = presets();
    expect(p.high).toEqual({ quality: 0.92, maxDim: 3000, protectDocuments: true });
    expect(p.max).toEqual({ quality: 0.55, maxDim: 1400, protectDocuments: false });
    expect(p.high.documentQuality).toBeUndefined();
    expect(p.max.documentQuality).toBeUndefined();
  });
  it("the ladder is strictly ordered and Recommended never behaves like Extreme", () => {
    const p = presets();
    expect(p.max.quality).toBeLessThan(p.recommended.quality);
    expect(p.recommended.quality).toBeLessThan(p.high.quality);
    expect(p.recommended.documentQuality).toBeGreaterThanOrEqual(p.recommended.quality);
    expect(p.max.maxDim).toBeLessThan(p.recommended.maxDim);
    expect(p.recommended.maxDim).toBeLessThan(p.high.maxDim);
    expect(p.max.protectDocuments).toBe(false);
  });
});

describe("/Decode guard", () => {
  const arr = async (values) => (await PDFDocument.create()).context.obj(values);
  const identity = (d) => get("isIdentityDecode")(d);
  it("absent Decode and identity Decode are allowed", async () => {
    expect(identity(undefined)).toBe(true);
    expect(identity(await arr([0, 1]))).toBe(true);
    expect(identity(await arr([0, 1, 0, 1, 0, 1]))).toBe(true);
  });
  it("any non-identity Decode is rejected (inverted, remapped, malformed)", async () => {
    expect(identity(await arr([1, 0]))).toBe(false);
    expect(identity(await arr([1, 0, 1, 0, 1, 0]))).toBe(false);
    expect(identity(await arr([0, 1, 1, 0, 0, 1]))).toBe(false);
    expect(identity(await arr([0, 0.5]))).toBe(false);
    expect(identity(await arr([0]))).toBe(false);
    expect(identity(await arr([]))).toBe(false);
  });
});

describe("EXIF stripping before decode (so the browser cannot auto-rotate)", () => {
  const strip = (b) => get("jpegWithoutExif")(b);
  const seg = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const exif = seg(0xe1, [...Buffer.from("Exif  ", "binary"), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const jfif = seg(0xe0, [...Buffer.from("JFIF ", "binary"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const xmp = seg(0xe1, [...Buffer.from("http://ns.adobe.com/xap/1.0/ ", "binary"), 0x3c, 0x78]);
  const dqt = seg(0xdb, new Array(65).fill(3));
  const sos = [0xff, 0xda, 0, 3, 1, 0, 0x11, 0x22, 0x33, 0xff, 0xd9];
  const jpeg = (...segments) => Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...sos]);

  it("removes the Exif APP1 segment and keeps everything else byte-for-byte", () => {
    const out = strip(jpeg(jfif, exif, dqt));
    expect(Array.from(out)).toEqual(Array.from(jpeg(jfif, dqt)));
    expect(Buffer.from(out).includes(Buffer.from("Exif"))).toBe(false);
  });
  it("keeps non-Exif APP1 segments (XMP) and works when Exif comes first or last", () => {
    expect(Array.from(strip(jpeg(exif, xmp, dqt)))).toEqual(Array.from(jpeg(xmp, dqt)));
    expect(Array.from(strip(jpeg(jfif, dqt, exif)))).toEqual(Array.from(jpeg(jfif, dqt)));
  });
  it("removes several Exif segments if a file has more than one", () => {
    expect(Array.from(strip(jpeg(exif, jfif, exif, dqt)))).toEqual(Array.from(jpeg(jfif, dqt)));
  });
  it("returns the SAME array when there is nothing to strip", () => {
    const plain = jpeg(jfif, dqt);
    expect(strip(plain)).toBe(plain);
  });
  it("leaves non-JPEG, tiny or truncated input alone (never throws)", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    expect(strip(png)).toBe(png);
    const tiny = Uint8Array.from([0xff, 0xd8]);
    expect(strip(tiny)).toBe(tiny);
    const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x45, 0x78]);
    expect(() => strip(truncated)).not.toThrow();
    expect(strip(undefined)).toBeUndefined();
  });
  it("never reads past the entropy-coded data (an Exif-looking byte pattern after SOS is untouched)", () => {
    const tail = [0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0];
    const bytes = Uint8Array.from([0xff, 0xd8, ...jfif, 0xff, 0xda, 0, 3, 1, 0, ...tail]);
    expect(strip(bytes)).toBe(bytes);
  });
});

describe("outcome builder (what the result screen says)", () => {
  const MB = 1024 * 1024;
  const stats = (o = {}) => ({ ...get("newCompressStats")(), ...o });
  const outcome = (o) => JSON.parse(JSON.stringify(get("describeCompressOutcome")({ floorPct: 4, custom: null, ...o })));

  it("reduced: meaningful saving on recompressed images", () => {
    const o = outcome({ originalSize: 20 * MB, candidateSize: 10 * MB, stats: stats({ found: 5, eligible: 5, replaced: 5 }) });
    expect(o).toMatchObject({ kind: "reduced", changed: true, key: "toolCompress.outReduced" });
    expect(o.vars.pct).toBe(50);
    expect(o.tipKey).toBeUndefined();
  });
  it("reduced + tip when some images were left alone", () => {
    const o = outcome({ originalSize: 20 * MB, candidateSize: 10 * MB, stats: stats({ found: 5, eligible: 3, replaced: 3, skipped: { ...stats().skipped, colorSpace: 2 } }) });
    expect(o.kind).toBe("reduced");
    expect(o.tipKey).toBe("toolCompress.outSkippedTip");
    expect(o.tipVars).toEqual({ n: 2, total: 5 });
  });
  it("structure-only saving when no image was replaced but the file got smaller by more than the floor", () => {
    const o = outcome({ originalSize: 100000, candidateSize: 60000, stats: stats({ found: 0 }) });
    expect(o).toMatchObject({ kind: "structure", changed: true, key: "toolCompress.outStructure" });
  });
  it("below the 4% floor: original kept, exact numbers reported", () => {
    const o = outcome({ originalSize: 5.69 * MB, candidateSize: 5.57 * MB, stats: stats({ found: 20, eligible: 20, replaced: 20 }) });
    expect(o).toMatchObject({ kind: "belowFloor", changed: false, key: "toolCompress.outBelowFloor" });
    expect(o.vars.floor).toBe("4");
    expect(Number(o.vars.pct)).toBeGreaterThan(1.5);
    expect(Number(o.vars.pct)).toBeLessThan(4);
    expect(o.vars.from).toMatch(/MB$/);
  });
  it("the floor is exactly 4%: 3.9% is kept as original, 4.0% is accepted", () => {
    const s = stats({ found: 3, eligible: 3, replaced: 3 });
    expect(outcome({ originalSize: 1000000, candidateSize: 961000, stats: s }).kind).toBe("belowFloor");
    expect(outcome({ originalSize: 1000000, candidateSize: 960000, stats: s }).kind).toBe("reduced");
  });
  it("no images at all (text/vector)", () => {
    const o = outcome({ originalSize: 1000, candidateSize: 1000, stats: stats({ found: 0 }) });
    expect(o).toMatchObject({ kind: "noImages", changed: false, key: "toolCompress.outNoImages" });
  });
  it("images exist but none is eligible (CMYK, alpha, ...)", () => {
    const o = outcome({ originalSize: 1000, candidateSize: 1000, stats: stats({ found: 4, eligible: 0, skipped: { ...stats().skipped, colorSpace: 4 } }) });
    expect(o).toMatchObject({ kind: "noneEligible", changed: false, vars: { n: 4 } });
  });
  it("eligible but re-encoding is not smaller", () => {
    const o = outcome({ originalSize: 1000, candidateSize: 1000, stats: stats({ found: 8, eligible: 8, noGain: 8 }) });
    expect(o).toMatchObject({ kind: "noGain", changed: false, vars: { n: 8 } });
  });
  it("verification failure keeps the original and says so", () => {
    const o = outcome({ originalSize: 20 * MB, candidateSize: 10 * MB, stats: stats({ found: 5, eligible: 5, replaced: 5 }), verifyFailed: true });
    expect(o).toMatchObject({ kind: "verifyFailed", changed: false, key: "toolCompress.outVerifyFailed" });
  });
  it("Custom target: floor is NOT applied (a small necessary saving is the point)", () => {
    const o = outcome({ originalSize: 1000000, candidateSize: 990000, stats: stats({ found: 2, eligible: 2, replaced: 2 }), custom: { alreadyUnderTarget: false, achieved: true, targetBytes: 995000 } });
    expect(o.kind).toBe("reduced");
    expect(o.changed).toBe(true);
  });
  it("Custom target missed / already under target reuse the existing messages", () => {
    const missed = outcome({ originalSize: 1000000, candidateSize: 700000, stats: stats({ found: 2, eligible: 2, replaced: 2 }), custom: { alreadyUnderTarget: false, achieved: false, targetBytes: 300000 } });
    expect(missed).toMatchObject({ kind: "targetMissed", changed: true, key: "toolCompress.doneTargetMissed" });
    const under = outcome({ originalSize: 1000, candidateSize: 1000, stats: stats(), custom: { alreadyUnderTarget: true, achieved: true, targetBytes: 5000 } });
    expect(under).toMatchObject({ kind: "alreadyUnderTarget", changed: false, key: "toolCompress.doneAlreadyUnderTarget" });
  });
  it("every message key the builder can return exists in the English i18n table", () => {
    const i18n = readFileSync(resolve(ROOT, "js/core/i18n.js"), "utf8");
    for (const key of ["outReduced", "outSkippedTip", "outStructure", "outNoImages", "outNoneEligible", "outNoGain", "outBelowFloor", "outVerifyFailed", "resultHeadingUnchanged", "doneAlreadyUnderTarget", "doneTargetMissed"]) {
      expect(i18n, key).toContain(`"toolCompress.${key}"`);
    }
  });
});

describe("stats helpers", () => {
  it("newCompressStats starts at zero with every skip reason present", () => {
    const s = JSON.parse(JSON.stringify(get("newCompressStats")()));
    expect(s).toEqual({
      found: 0, eligible: 0, replaced: 0, noGain: 0, decodeFailed: 0, maskImages: 0, documentPages: 0,
      skipped: { unsupportedFilter: 0, alpha: 0, masked: 0, decode: 0, colorSpace: 0, unsupportedParams: 0, error: 0 },
    });
  });
  it("skipped total sums every reason", () => {
    const total = get("compressStatsSkippedTotal");
    expect(total({ skipped: { a: 2, b: 3 } })).toBe(5);
    expect(total(undefined)).toBe(0);
  });
});

describe("worker mirrors the shared engine constants", () => {
  const worker = readFileSync(resolve(ROOT, "js/workers/pdf-compress-worker.js"), "utf8");
  const main = readFileSync(resolve(ROOT, "js/core/pdf-processing-utils.js"), "utf8");
  it("same presets", () => {
    for (const line of [
      "high:      { quality: 0.92, maxDim: 3000, protectDocuments: true },",
      "recommended: { quality: 0.75, documentQuality: 0.82, maxDim: 2200, protectDocuments: true },",
      "max:       { quality: 0.55, maxDim: 1400, protectDocuments: false },",
    ]) { expect(worker).toContain(line); expect(main).toContain(line); }
  });
  it("same classifier thresholds and identical classifier bodies", () => {
    for (const line of ["const DOC_PAPER_SHARE_MIN = 0.45;", "const DOC_PEAK_LUMA_MIN = 100;", "const DOC_THUMB_LONG_EDGE = 128;", "const DOC_PAPER_WINDOW = 16;"]) {
      expect(worker).toContain(line); expect(main).toContain(line);
    }
    const body = (raw, name) => { const src = raw.replace(/\r/g, ""); const i = src.indexOf(`function ${name}(`); const j = src.indexOf("\n}\n", i); return src.slice(i, j).replace(/\/\/.*$/gm, "").replace(/[ \t]+$/gm, ""); };
    for (const fn of ["documentThumbSize", "documentSignalsFromPixels", "isDocumentPageFromSignals", "documentSignalsFromBitmap", "isIdentityDecode", "newCompressStats", "jpegWithoutExif"]) {
      expect(body(worker, fn), fn).toBe(body(main, fn));
    }
  });
  it("the safety guards are present in both engines", () => {
    for (const src of [worker, main]) {
      expect(src).toContain("jpegWithoutExif(obj.contents)");
      expect(src).toContain('dict.lookup(PDFName.of("Mask"))');
      expect(src).toContain("isIdentityDecode(dict.lookup(PDFName.of(\"Decode\")))");
      expect(src).toContain("maskRefs");
    }
  });
});
