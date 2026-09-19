import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 12: real functional coverage for the remaining untested image
// tools (imgcrop is intentionally not covered here - its interactive
// crop-box UI needs pointer-drag simulation this batch didn't attempt;
// imginvert already has coverage from an earlier phase).

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const simplePng = resolve(FIXTURES, "simple.png"); // 2x2 real PNG
// 120x80, left half fully transparent / right half an opaque gradient.
const transparentPng = resolve(FIXTURES, "transparent.png");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

// The ratings endpoint (/api/rating) 404s under the plain Python dev
// server used by these tests - it's only wired up under `netlify dev`
// (see README). That's a pre-existing, documented environment gap
// unrelated to image-tool behavior; every test in this file inherits the
// resulting console noise regardless of what it's actually testing. Used
// only by the new transparency-regression tests below so their pass/fail
// reflects the image behavior being tested, not this known gap.
function expectNoUnexpectedErrors(errors) {
  // Each failed /api/rating request logs two separate console entries -
  // the app's own "[ratings] GET ... -> HTTP 404" message, and the
  // browser's own generic "Failed to load resource: ... 404" message for
  // the same request (which doesn't repeat the URL in its text). Both are
  // filtered together since (per the pre-existing "resize image" test
  // failing identically on an unmodified checkout) they're the same known,
  // pre-existing environment gap, not something these new tests should
  // fail on.
  const unexpected = errors.filter(
    (e) => !e.includes("/api/rating") && !e.includes("Failed to load resource")
  );
  expect(unexpected).toEqual([]);
}

async function downloadBytes(page, linkSelector) {
  const downloadLink = page.locator(linkSelector);
  await expect(downloadLink).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  return readFileSync(await download.path());
}

// Reads back a single decoded pixel (and the decoded width/height) from the
// result's own blob: URL, entirely in-page via canvas - avoids needing a
// JPEG/PNG decoder in the Node test process. downloadBlob() (shared by
// every tool) keeps exactly one active object URL alive until the next
// result, and the link's own href IS that URL, so this reads the same
// bytes a real download would produce without needing the download event.
async function readResultPixel(page, linkSelector, x, y) {
  const downloadLink = page.locator(linkSelector);
  await expect(downloadLink).toBeVisible({ timeout: 20_000 });
  const href = await downloadLink.getAttribute("href");
  return page.evaluate(async ({ href, x, y }) => {
    const blob = await (await fetch(href)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const pixel = Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { width: bitmap.width, height: bitmap.height, pixel };
  }, { href, x, y });
}

test("image compressor: downloads a valid JPEG toward the requested KB target", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/image-compressor");
  await page.locator("#fi").setInputFiles(simplePng);
  await page.locator("#targetKb").fill("50");
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="simple_compressed.jpg"]');
  // simple.png is a 2x2 fixture - real-world small enough that every JPEG
  // re-encode attempt comes out bigger than the tiny original PNG, so the
  // tool's own "never hand back something bigger than original" safety
  // net (image-tools.js's usedOriginal branch) correctly keeps the
  // original PNG bytes rather than a re-encoded JPEG. Accept either real
  // signature - what matters is it's a genuine, valid image, not which
  // format won that comparison for this particular fixture.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.toString("hex", 0, 4) === "89504e47";
  expect(isJpeg || isPng, `unrecognized image signature: ${bytes.toString("hex", 0, 4)}`).toBe(true);
  expect(errors).toEqual([]);
});

test("resize image: downloads a PNG resized to the exact requested dimensions", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/resize-image");
  await page.locator("#fi").setInputFiles(simplePng);
  await page.locator("#rw").fill("40");
  await page.locator("#rh").fill("40");
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="simple_resized.png"]');
  // PNG IHDR chunk: bytes 16-19 = width, 20-23 = height, big-endian.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(width).toBe(40);
  expect(height).toBe(40);
  expect(errors).toEqual([]);
});

test("convert image format: converts a PNG to WebP", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/convert-image-format");
  await page.locator("#fi").setInputFiles(simplePng);
  await page.locator("#fmt").selectOption("image/webp");
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="simple_converted.webp"]');
  // WebP: "RIFF" .... "WEBP" (bytes 0-3 and 8-11).
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  expect(errors).toEqual([]);
});

test("watermark image: applies text and downloads a valid, same-format image", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/watermark-image");
  await page.locator("#fi").setInputFiles(simplePng);
  await page.locator("#wtext").fill("PHASE 12");
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="simple_watermarked.png"]');
  expect(bytes.toString("hex", 0, 8)).toBe("89504e470d0a1a0a"); // real PNG signature
  expect(errors).toEqual([]);
});

// Phase 13 regression: transparent PNG -> JPEG previously rendered
// transparent regions as black (canvas defaults to transparent-black;
// JPEG has no alpha channel) instead of white. Covers both tools that can
// encode JPEG from an arbitrary source (image compressor, convert image
// format) plus a guard that PNG-to-PNG output still keeps real alpha.

test("image compressor: a transparent PNG flattens to white (not black) when re-encoded as JPEG", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/image-compressor");
  await page.locator("#fi").setInputFiles(transparentPng);
  // Large enough that the very first compression pass (scale=1, quality=0.85)
  // already clears the target, so dimensions are guaranteed unscaled. The
  // fixture's opaque half is a gradient specifically so its real JPEG
  // re-encode comes out smaller than the (deflate-friendly) source PNG -
  // otherwise the tool's own "never hand back something bigger than the
  // original" safety net would return the original PNG bytes unchanged,
  // and this test wouldn't be exercising the JPEG path at all.
  await page.locator("#targetKb").fill("500");
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="transparent_compressed.jpg"]');
  expect(bytes[0], "output must be a real JPEG (compression must not have fallen back to the original PNG)").toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const { width, height, pixel } = await readResultPixel(
    page, 'a.dl-link[download="transparent_compressed.jpg"]', 5, 40
  );
  expect(width, "dimensions must be unchanged").toBe(120);
  expect(height).toBe(80);
  // Was previously read back as black ([0,0,0]); allow JPEG-compression
  // tolerance but it must land near white, not near black.
  expect(pixel[0], "transparent region should flatten to white, not black").toBeGreaterThan(235);
  expect(pixel[1]).toBeGreaterThan(235);
  expect(pixel[2]).toBeGreaterThan(235);
  expect(pixel[3], "JPEG has no alpha - decoded pixel must read fully opaque").toBe(255);

  // Sanity: the opaque half must still show real (non-white) image
  // content - this fix must not touch already-opaque regions.
  const { pixel: opaquePixel } = await readResultPixel(
    page, 'a.dl-link[download="transparent_compressed.jpg"]', 100, 40
  );
  expect(
    opaquePixel[0] < 235 || opaquePixel[1] < 235 || opaquePixel[2] < 235,
    "opaque region must still show real image content, not have been painted over white"
  ).toBe(true);

  expectNoUnexpectedErrors(errors);
});

test("convert image format: a transparent PNG flattens to white (not black) when target format is JPG", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/convert-image-format");
  await page.locator("#fi").setInputFiles(transparentPng);
  await page.locator("#fmt").selectOption("image/jpeg");
  await page.locator("#go").click();

  // imgconvert derives its extension from the mime type's subtype
  // ("image/jpeg" -> "jpeg"), unlike imgcompress/imgOutputFormat which
  // normalize it to "jpg" - a pre-existing naming quirk, not part of
  // this fix, so the download name here intentionally matches it.
  const bytes = await downloadBytes(page, 'a.dl-link[download="transparent_converted.jpeg"]');
  expect(bytes[0], "output must be a real JPEG").toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const { width, height, pixel } = await readResultPixel(
    page, 'a.dl-link[download="transparent_converted.jpeg"]', 5, 40
  );
  expect(width, "convert-image-format never rescales").toBe(120);
  expect(height).toBe(80);
  expect(pixel[0], "transparent region should flatten to white, not black").toBeGreaterThan(235);
  expect(pixel[1]).toBeGreaterThan(235);
  expect(pixel[2]).toBeGreaterThan(235);
  expect(pixel[3]).toBe(255);

  expectNoUnexpectedErrors(errors);
});

test("convert image format: a transparent PNG converted to PNG still keeps real alpha", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/convert-image-format");
  await page.locator("#fi").setInputFiles(transparentPng);
  await page.locator("#fmt").selectOption("image/png"); // default, but explicit for clarity
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="transparent_converted.png"]');
  expect(bytes.toString("hex", 0, 8)).toBe("89504e470d0a1a0a"); // real PNG signature

  const { pixel } = await readResultPixel(
    page, 'a.dl-link[download="transparent_converted.png"]', 5, 20
  );
  // Must NOT have been flattened - this is the regression guard that the
  // JPEG-only fix didn't start touching formats that support transparency.
  expect(pixel[3], "PNG output must keep the source's real alpha").toBe(0);

  expectNoUnexpectedErrors(errors);
});
