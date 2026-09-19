import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";

// Compress PDF V2 - real-browser coverage, through the real UI and the real
// worker / main-thread engines. Every fixture is generated here (canvas ->
// JPEG bytes -> pdf-lib), so no binary is committed. The test names map to
// the approved test plan: A photo-heavy, B scanned page, C already
// compressed, D text/vector, E PNG/Flate, F worker-vs-fallback, H no-op
// messaging, I photo-vs-document differentiation, J guards (EXIF-6,
// non-identity /Decode, /Mask, soft masks). G (cancellation) lives, unchanged,
// in tests/browser/compress-fallback.spec.js.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const imageHeavyPdf = resolve(FIXTURES, "image-heavy.pdf"); // Flate/PNG images

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}
// /api/rating 404s under the plain dev server (only wired under `netlify dev`).
function expectNoUnexpectedErrors(errors) {
  expect(errors.filter((e) => !e.includes("/api/rating") && !e.includes("Failed to load resource"))).toEqual([]);
}

// ---------------------------------------------------------------- fixtures
// In-page JPEG generators (seeded, deterministic). "photo": smooth colour
// blobs + sensor-like grain. "page": off-white paper with lines of text.
async function makeJpeg(page, spec) {
  const bytes = await page.evaluate(async ({ width, height, kind, quality, seed, grain, exif }) => {
    let s = seed >>> 0;
    const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (kind === "photo" || kind === "dark") {
      const g = ctx.createLinearGradient(0, 0, width, height);
      const pal = kind === "dark" ? ["#050810", "#0a0f1c", "#03060c"] : ["#3a5f8a", "#c58a4a", "#6fae8e"];
      g.addColorStop(0, pal[0]); g.addColorStop(0.5, pal[1]); g.addColorStop(1, pal[2]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 45; i++) {
        ctx.fillStyle = kind === "dark" ? `rgb(${rand() * 40 | 0},${rand() * 40 | 0},${rand() * 60 | 0})` : `rgb(${rand() * 255 | 0},${rand() * 255 | 0},${rand() * 255 | 0})`;
        ctx.beginPath(); ctx.ellipse(rand() * width, rand() * height, 30 + rand() * width / 5, 30 + rand() * height / 5, rand() * 3, 0, 7); ctx.fill();
      }
    } else { // "page"
      ctx.fillStyle = "rgb(238,235,228)"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgb(25,25,30)"; ctx.font = `${Math.round(height / 95)}px Arial`;
      const words = "the quick brown fox jumps over lazy dog invoice total amount payable receipt ledger 2026 section".split(" ");
      for (let y = height * 0.06; y < height * 0.94; y += height / 60) {
        let line = ""; for (let k = 0; k < 8 + (rand() * 6 | 0); k++) line += words[rand() * words.length | 0] + " ";
        ctx.fillText(line, width * 0.08, y);
      }
    }
    const img = ctx.getImageData(0, 0, width, height); const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rand() - 0.5) * grain; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { width: spec.width, height: spec.height, kind: spec.kind || "photo", quality: spec.quality ?? 0.9, seed: spec.seed ?? 1, grain: spec.grain ?? 24 });
  let buf = Buffer.from(bytes);
  if (spec.exifOrientation) buf = withExifOrientation(buf, spec.exifOrientation);
  return buf;
}

// Inserts an APP1/EXIF segment carrying Orientation=N right after SOI.
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

// One image per page, page sized proportionally to the image. `mutate`
// (optional) edits the saved document's image XObjects afterwards - pdf-lib
// only creates the image objects at save time, so they can't be touched
// before that.
async function pdfFromJpegs(jpegs, mutate) {
  const doc = await PDFDocument.create();
  for (const bytes of jpegs) {
    const img = await doc.embedJpg(bytes);
    const page = doc.addPage([img.width * 0.24, img.height * 0.24]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  let out = Buffer.from(await doc.save());
  if (mutate) {
    const reloaded = await PDFDocument.load(out);
    const images = [...reloaded.context.enumerateIndirectObjects()]
      .filter(([, o]) => o instanceof PDFRawStream && o.dict.lookup(PDFName.of("Subtype"))?.asString?.() === "/Image")
      .map(([, o]) => o);
    mutate(reloaded, images);
    out = Buffer.from(await reloaded.save({ useObjectStreams: false }));
  }
  return out;
}

async function textOnlyPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 40; p++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < 50; l++) page.drawText(`Page ${p + 1} line ${l + 1}: the quick brown fox jumps over the lazy dog`, { x: 40, y: 800 - l * 15, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

// Every image XObject in a PDF (dimensions, filter, Decode, Mask, raw bytes).
async function imageStreams(bytes) {
  const doc = await PDFDocument.load(bytes);
  const out = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.lookup(PDFName.of("Subtype"))?.asString?.() !== "/Image") continue;
    out.push({
      ref: ref.toString(), w: d.lookup(PDFName.of("Width"))?.asNumber(), h: d.lookup(PDFName.of("Height"))?.asNumber(),
      filter: d.lookup(PDFName.of("Filter"))?.toString(), decode: d.lookup(PDFName.of("Decode"))?.toString() ?? null,
      mask: d.lookup(PDFName.of("Mask"))?.toString() ?? null, hasSMask: !!d.lookup(PDFName.of("SMask")),
      length: obj.contents.length, contents: Buffer.from(obj.contents),
    });
  }
  return out;
}
const pageCount = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();

// ---------------------------------------------------------------- drivers
async function openCompress(page, { fallback = false } = {}) {
  if (fallback) await page.addInitScript(() => { delete window.OffscreenCanvas; });
  await page.goto("/compress-pdf");
  await expect(page.locator("#dz")).toBeVisible({ timeout: 15_000 });
}

// The real user flow: file -> level radio -> Compress -> result -> download.
async function compressViaUi(page, buffer, name, level = "recommended", { customKb } = {}) {
  await page.locator("#fi").setInputFiles({ name, mimeType: "application/pdf", buffer });
  await page.locator(`#compressLevelPicker .level-row[data-preset="${level}"]`).click();
  if (level === "custom") await page.locator("#customTargetKB").fill(String(customKb));
  await page.locator("#go").click();
  const link = page.locator("a.dl-link");
  await expect(link).toBeVisible({ timeout: 120_000 });
  const note = page.locator(".result-box .compress-note");
  await expect(note).toBeVisible();
  const info = {
    kind: await note.getAttribute("data-outcome"),
    text: (await note.innerText()).replace(/\s+/g, " ").trim(),
    role: await note.getAttribute("role"),
    heading: (await page.locator(".result-box .result-head h3").innerText()).trim(),
    badgeClass: await page.locator(".result-box .size-badge").getAttribute("class"),
  };
  const dl = page.waitForEvent("download");
  await link.click();
  const download = await dl;
  return { ...info, bytes: readFileSync(await download.path()), filename: download.suggestedFilename() };
}

// Direct engine call (worker or main-thread) -> output bytes + stats.
async function runEngine(page, buffer, mode, preset) {
  const r = await page.evaluate(async ({ b64, mode, preset }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fn = mode === "worker" ? recompressPdfImages : recompressPdfImagesMainThread;
    const res = await fn(bytes, preset);
    let bin = ""; const chunk = 0x8000;
    for (let i = 0; i < res.bytes.length; i += chunk) bin += String.fromCharCode(...res.bytes.subarray(i, i + chunk));
    return { b64: btoa(bin), stats: res.stats, touched: res.imagesRecompressed };
  }, { b64: buffer.toString("base64"), mode, preset });
  return { bytes: Buffer.from(r.b64, "base64"), stats: r.stats, touched: r.touched };
}
async function openEngine(page) {
  await page.goto("/compress-pdf");
  await page.waitForFunction(() => typeof recompressPdfImages === "function" && typeof recompressPdfImagesMainThread === "function");
}

// ---------------------------------------------------------------- tests
test("A. photo-heavy PDF (mid-size q90 photos): Recommended now gives a meaningful reduction, with a success message", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const jpegs = [];
  for (let i = 0; i < 12; i++) jpegs.push(await makeJpeg(page, { width: 1600, height: 1000, quality: 0.9, seed: 100 + i, grain: 24 }));
  const input = await pdfFromJpegs(jpegs);
  const r = await compressViaUi(page, input, "album.pdf", "recommended");
  const ratio = r.bytes.length / input.length;
  console.log(`[compress-v2] A: ${input.length} -> ${r.bytes.length} (${((1 - ratio) * 100).toFixed(1)}% smaller)`);
  expect(ratio).toBeLessThan(0.85); // >=15% smaller; before V2 this class of file stayed ~unchanged
  expect(await pageCount(r.bytes)).toBe(12);
  expect(r.kind).toBe("reduced");
  expect(r.text).toMatch(/Reduced from .* to .* \(\d+% smaller\)\. Text and vector content were not changed\./);
  expect(r.role).toBe("status");
  expect(r.heading).toContain("All done");
  expect(r.badgeClass.split(/\s+/)).toContain("good");
  expectNoUnexpectedErrors(errors);
});

test("B. scanned document pages keep the document ceiling (2800px) and stay readable", async ({ page }) => {
  test.setTimeout(180_000);
  await openEngine(page);
  const scans = [await makeJpeg(page, { width: 2480, height: 3508, kind: "page", quality: 0.85, seed: 7, grain: 6 }), await makeJpeg(page, { width: 2480, height: 3508, kind: "page", quality: 0.85, seed: 8, grain: 6 })];
  const input = await pdfFromJpegs(scans);
  const rec = await runEngine(page, input, "worker", "recommended");
  const ext = await runEngine(page, input, "worker", "max");
  expect(rec.stats.documentPages).toBe(2);
  const recImgs = await imageStreams(rec.bytes);
  expect(recImgs.map((i) => Math.max(i.w, i.h))).toEqual([2800, 2800]); // protected: 3508 -> the 2800 document floor, not the 2200 photo cap
  const extImgs = await imageStreams(ext.bytes);
  expect(extImgs.map((i) => Math.max(i.w, i.h))).toEqual([1400, 1400]); // Extreme unchanged
  expect(rec.bytes.length).toBeLessThan(input.length);

  // Text-edge fidelity: mean abs error (grey levels) in a band around ink, vs the
  // original page resampled to the same grid. Recommended must be clearly better than Extreme.
  const orig = (await imageStreams(input))[0].contents;
  const err = await page.evaluate(async ({ o, a, b }) => {
    const decode = async (arr) => createImageBitmap(new Blob([new Uint8Array(arr)], { type: "image/jpeg" }), { imageOrientation: "none" });
    const grey = (bmp, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(bmp, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; };
    const bo = await decode(o); const W = 700, H = Math.round(700 * bo.height / bo.width);
    const ref = grey(bo, W, H);
    const near = new Uint8Array(W * H); // ink pixels + a 3px halo
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ref[y * W + x] < 110) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W) near[yy * W + xx] = 1; }
    const mae = async (arr) => { const g = grey(await decode(arr), W, H); let s = 0, n = 0; for (let i = 0; i < g.length; i++) if (near[i]) { s += Math.abs(g[i] - ref[i]); n++; } return s / Math.max(1, n); };
    return { rec: await mae(a), ext: await mae(b) };
  }, { o: [...orig], a: [...recImgs[0].contents], b: [...extImgs[0].contents] });
  console.log(`[compress-v2] B: text-edge MAE recommended=${err.rec.toFixed(2)} extreme=${err.ext.toFixed(2)}`);
  expect(err.rec).toBeLessThan(err.ext);
  expect(err.rec).toBeLessThan(12);
});

test("I. 4:3 and 3:2 photos are NOT protected as documents; an A4 page IS - in the same PDF, worker and main-thread agree", async ({ page }) => {
  test.setTimeout(180_000);
  await openEngine(page);
  const items = [
    await makeJpeg(page, { width: 3200, height: 2400, quality: 0.9, seed: 31, grain: 20 }), // 4:3 photo
    await makeJpeg(page, { width: 3600, height: 2400, quality: 0.9, seed: 32, grain: 20 }), // 3:2 photo
    await makeJpeg(page, { width: 2480, height: 3508, kind: "page", quality: 0.85, seed: 33, grain: 6 }), // A4 page
    await makeJpeg(page, { width: 2400, height: 3200, kind: "dark", quality: 0.9, seed: 34, grain: 10 }), // dark 3:4 photo
  ];
  const input = await pdfFromJpegs(items);
  for (const mode of ["worker", "main"]) {
    const r = await runEngine(page, input, mode, "recommended");
    const imgs = await imageStreams(r.bytes);
    const longs = imgs.map((i) => Math.max(i.w, i.h));
    expect(longs[0], `${mode}: 4:3 photo capped at the photo ceiling`).toBe(2200);
    expect(longs[1], `${mode}: 3:2 photo capped at the photo ceiling`).toBe(2200);
    expect(longs[2], `${mode}: A4 page keeps the document ceiling`).toBe(2800);
    expect(longs[3], `${mode}: dark photo is a photo`).toBe(2200);
    expect(r.stats.documentPages, `${mode}: exactly one document page`).toBe(1);
    expect(r.stats.replaced).toBe(4);
    // Orientation and aspect ratio are preserved for every image.
    imgs.forEach((im, i) => expect(im.w / im.h).toBeCloseTo([3200 / 2400, 3600 / 2400, 2480 / 3508, 2400 / 3200][i], 1));
  }
});

test("C. already-compressed JPEGs never grow, and the user is told why nothing changed", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const jpegs = [];
  for (let i = 0; i < 6; i++) jpegs.push(await makeJpeg(page, { width: 1200, height: 800, quality: 0.5, seed: 200 + i, grain: 10 }));
  const input = await pdfFromJpegs(jpegs);
  const r = await compressViaUi(page, input, "small.pdf", "recommended");
  expect(r.bytes.length).toBeLessThanOrEqual(input.length);
  expect(["noGain", "belowFloor"]).toContain(r.kind);
  expect(r.bytes.length).toBe(input.length); // original returned untouched
  expect(r.heading).toContain("No smaller version found");
  expect(r.heading).not.toContain("All done");
  expect(r.badgeClass.split(/\s+/)).not.toContain("bad"); // no red "failure" badge on a no-op
  expect(r.text).toMatch(/already compressed about as far|below the 4% minimum/);
  expectNoUnexpectedErrors(errors);
});

test("D. text/vector-only PDF is identified as having no images, and returned unchanged and valid", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const input = await textOnlyPdf();
  const r = await compressViaUi(page, input, "text.pdf", "recommended");
  expect(r.kind).toBe("noImages");
  expect(r.text).toContain("no images to compress");
  expect(r.heading).toContain("No smaller version found");
  expect(r.badgeClass.split(/\s+/)).not.toContain("bad");
  expect(await pageCount(r.bytes)).toBe(40);
  expect(r.bytes.length).toBe(input.length);
  expectNoUnexpectedErrors(errors);
});

test("E. PNG/Flate image-heavy PDF keeps its strong compression", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const input = readFileSync(imageHeavyPdf);
  const r = await compressViaUi(page, input, "image-heavy.pdf", "recommended");
  console.log(`[compress-v2] E: ${input.length} -> ${r.bytes.length}`);
  expect(r.kind).toBe("reduced");
  expect(r.bytes.length).toBeLessThan(input.length * 0.6);
  expect(await pageCount(r.bytes)).toBe(4);
  expectNoUnexpectedErrors(errors);
});

test("F. worker and main-thread fallback produce the same result through the real UI", async ({ browser }) => {
  test.setTimeout(240_000);
  const seedPage = await (await browser.newContext()).newPage();
  await openCompress(seedPage);
  const jpegs = [];
  for (let i = 0; i < 8; i++) jpegs.push(await makeJpeg(seedPage, { width: 1600, height: 1000, quality: 0.9, seed: 300 + i, grain: 24 }));
  const input = await pdfFromJpegs(jpegs);
  await seedPage.context().close();

  const results = {};
  for (const fallback of [false, true]) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const p = await ctx.newPage();
    await openCompress(p, { fallback });
    if (fallback) expect(await p.evaluate(() => typeof OffscreenCanvas)).toBe("undefined"); // really the fallback
    results[fallback ? "main" : "worker"] = await compressViaUi(p, input, "parity.pdf", "recommended");
    await ctx.close();
  }
  const w = results.worker, m = results.main;
  console.log(`[compress-v2] F: worker ${w.bytes.length} vs main-thread ${m.bytes.length}`);
  expect(Math.abs(w.bytes.length - m.bytes.length) / w.bytes.length).toBeLessThan(0.005);
  expect(w.kind).toBe(m.kind);
  expect(w.text).toBe(m.text);
});

test("J. safety guards: EXIF-6, non-identity /Decode, /Mask and soft masks - worker and main-thread", async ({ page }) => {
  test.setTimeout(240_000);
  await openEngine(page);
  const plain = await makeJpeg(page, { width: 3000, height: 2000, quality: 0.9, seed: 41, grain: 20 });
  const exif6 = await makeJpeg(page, { width: 3000, height: 2000, quality: 0.9, seed: 42, grain: 20, exifOrientation: 6 });

  // --- EXIF orientation 6: must NOT be rotated (3000x2000 stays landscape)
  const exifPdf = await pdfFromJpegs([exif6]);
  // --- non-identity /Decode ([1 0 ...] = inverted)
  const decodePdf = await pdfFromJpegs([plain], (doc, [im]) => im.dict.set(PDFName.of("Decode"), doc.context.obj([1, 0, 1, 0, 1, 0])));
  // --- identity /Decode is fine to recompress (and is then dropped)
  const identityPdf = await pdfFromJpegs([plain], (doc, [im]) => im.dict.set(PDFName.of("Decode"), doc.context.obj([0, 1, 0, 1, 0, 1])));
  // --- colour-key /Mask
  const maskPdf = await pdfFromJpegs([plain], (doc, [im]) => im.dict.set(PDFName.of("Mask"), doc.context.obj([250, 255, 250, 255, 250, 255])));
  // --- PNG with alpha -> RGB image + soft-mask image
  const alphaPdf = await (async () => {
    const png = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 1400; c.height = 900; const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, 1400, 900); g.addColorStop(0, "#c33"); g.addColorStop(1, "#36c"); x.fillStyle = g; x.fillRect(0, 0, 1400, 900); x.clearRect(0, 0, 300, 900); const b = await new Promise((r) => c.toBlob(r, "image/png")); return Array.from(new Uint8Array(await b.arrayBuffer())); });
    const doc = await PDFDocument.create(); const img = await doc.embedPng(Buffer.from(png)); const pg = doc.addPage([336, 216]); pg.drawImage(img, { x: 0, y: 0, width: 336, height: 216 }); return Buffer.from(await doc.save());
  })();

  for (const mode of ["worker", "main"]) {
    // EXIF
    const e = await runEngine(page, exifPdf, mode, "recommended");
    const [ei] = await imageStreams(e.bytes);
    expect(e.stats.replaced, `${mode} exif replaced`).toBe(1);
    expect(ei.w, `${mode}: EXIF-6 image must stay landscape (not auto-rotated)`).toBeGreaterThan(ei.h);
    expect(ei.w / ei.h).toBeCloseTo(3000 / 2000, 1);
    // non-identity Decode: untouched
    const d = await runEngine(page, decodePdf, mode, "recommended");
    const [di] = await imageStreams(d.bytes);
    expect(d.stats.skipped.decode, `${mode} decode skipped`).toBe(1);
    expect(d.stats.replaced).toBe(0);
    expect(di.decode).toMatch(/\[ 1 0 1 0 1 0 \]/);
    expect(di.contents.equals((await imageStreams(decodePdf))[0].contents)).toBe(true);
    // identity Decode: recompressed
    const id = await runEngine(page, identityPdf, mode, "recommended");
    expect(id.stats.replaced, `${mode} identity decode recompressed`).toBe(1);
    // colour-key Mask: untouched
    const m = await runEngine(page, maskPdf, mode, "recommended");
    const [mi] = await imageStreams(m.bytes);
    expect(m.stats.skipped.masked, `${mode} mask skipped`).toBe(1);
    expect(m.stats.replaced).toBe(0);
    expect(mi.mask).toMatch(/250 255 250 255 250 255/);
    expect(mi.contents.equals((await imageStreams(maskPdf))[0].contents)).toBe(true);
    // Alpha: RGB image skipped, its soft mask is excluded (not counted, never re-encoded)
    const a = await runEngine(page, alphaPdf, mode, "recommended");
    expect(a.stats.found, `${mode} alpha: only the visible image counts`).toBe(1);
    expect(a.stats.maskImages).toBe(1);
    expect(a.stats.skipped.alpha).toBe(1);
    expect(a.stats.replaced).toBe(0);
    const before = await imageStreams(alphaPdf), after = await imageStreams(a.bytes);
    expect(after.length).toBe(before.length);
    for (const b of before) expect(after.find((x) => x.ref === b.ref).contents.equals(b.contents), `${mode}: ${b.ref} byte-identical`).toBe(true);
  }
});

test("H. no-op messaging: images that can't be safely recompressed are explained (never a generic success)", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const png = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 1400; c.height = 900; const x = c.getContext("2d"); x.fillStyle = "#c33"; x.fillRect(0, 0, 1400, 900); x.clearRect(0, 0, 300, 900); const b = await new Promise((r) => c.toBlob(r, "image/png")); return Array.from(new Uint8Array(await b.arrayBuffer())); });
  const doc = await PDFDocument.create(); const img = await doc.embedPng(Buffer.from(png)); const pg = doc.addPage([336, 216]); pg.drawImage(img, { x: 0, y: 0, width: 336, height: 216 });
  const input = Buffer.from(await doc.save());
  const r = await compressViaUi(page, input, "alpha.pdf", "recommended");
  expect(r.kind).toBe("noneEligible");
  expect(r.text).toMatch(/1 images use formats we can't safely recompress yet/);
  expect(r.heading).toContain("No smaller version found");
  expect(r.badgeClass.split(/\s+/)).not.toContain("bad");
  expect(r.bytes.length).toBe(input.length);
  expectNoUnexpectedErrors(errors);
});

test("K. Extreme and Custom keep their behaviour", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = captureRuntimeErrors(page);
  await openCompress(page);
  const jpegs = [];
  for (let i = 0; i < 6; i++) jpegs.push(await makeJpeg(page, { width: 2000, height: 1300, quality: 0.9, seed: 400 + i, grain: 24 }));
  const input = await pdfFromJpegs(jpegs);
  const ext = await compressViaUi(page, input, "ext.pdf", "max");
  expect(ext.kind).toBe("reduced");
  const extImgs = await imageStreams(ext.bytes);
  expect(Math.max(...extImgs.map((i) => Math.max(i.w, i.h)))).toBeLessThanOrEqual(1400); // Extreme's ceiling, exactly as before
  await page.reload();
  await expect(page.locator("#dz")).toBeVisible();
  const target = Math.round(input.length * 0.3 / 1024);
  const custom = await compressViaUi(page, input, "custom.pdf", "custom", { customKb: target });
  expect(custom.bytes.length).toBeLessThan(input.length);
  expect(["reduced", "targetMissed"]).toContain(custom.kind);
  expect(custom.text.length).toBeGreaterThan(10);
  expectNoUnexpectedErrors(errors);
});
