import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

// Phase 2 (Compress PDF fallback responsiveness): coverage for
// recompressPdfImagesMainThread()/compressToTargetMainThread()
// (js/core/pdf-processing-utils.js) - the main-thread path Compress PDF
// falls back to when the Worker/OffscreenCanvas path
// (js/workers/pdf-compress-worker.js, unchanged by this phase) isn't
// available. These tests force that fallback deliberately, by deleting
// window.OffscreenCanvas before the page's own scripts run - that's
// exactly what compressWorkerSupported() checks, so this reliably
// exercises the fallback on any browser/CI runner regardless of its real
// capabilities, without needing an actually-old browser.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const imageHeavyPdf = resolve(FIXTURES, "image-heavy.pdf"); // 4 pages, one embedded raster image each

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

// Same pattern as tests/browser/image-operations.spec.js's
// expectNoUnexpectedErrors: the /api/rating endpoint 404s under the plain
// Python dev server these tests run against (it's only wired up under
// `netlify dev` - see README), which logs two console entries per failed
// request - the app's own "[ratings] GET ... -> HTTP 404" message and the
// browser's own generic "Failed to load resource: ... 404" message for
// the same request. Both are filtered together since this is a known,
// pre-existing environment gap unrelated to Compress PDF behavior, not
// something these tests should fail on.
function expectNoUnexpectedErrors(errors) {
  const unexpected = errors.filter(
    (e) => !e.includes("/api/rating") && !e.includes("Failed to load resource")
  );
  expect(unexpected).toEqual([]);
}

function forceMainThreadFallback(page) {
  return page.addInitScript(() => { delete window.OffscreenCanvas; });
}

// Adds a fixed artificial delay to every createImageBitmap() call - the
// one real async decode step recompressPdfImagesMainThread() awaits per
// image (js/core/pdf-processing-utils.js). Used only by the cancellation
// test below: with a small/fast fixture the whole 4-image fallback loop
// can otherwise complete (cooperative yields included) faster than two
// sequential, separately-awaited Playwright interactions can land -
// confirmed directly while developing this test, where every one of the
// fallback's own cancellation checkpoints had already reported
// aborted:false before the test's own Cancel click ever reached the
// page, on both a plain run and one under 20x CPU throttling. A fixed,
// deterministic per-image delay gives the test a guaranteed window to
// click Cancel in, independent of the test machine's real speed.
function injectPerImageDecodeDelay(page, delayMs) {
  return page.addInitScript((ms) => {
    const real = window.createImageBitmap.bind(window);
    window.createImageBitmap = (...args) =>
      new Promise((resolve) => setTimeout(resolve, ms)).then(() => real(...args));
  }, delayMs);
}

test("compress (forced fallback): an image-heavy PDF still produces a valid, correctly-paged result", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await forceMainThreadFallback(page);
  await page.goto("/compress-pdf");

  await page.locator("#fi").setInputFiles(imageHeavyPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const downloadLink = page.locator('a.dl-link[download="image-heavy_compressed.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 45_000 });

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());

  // Must be a real, loadable PDF with the same page count as the input -
  // the same "never hand back something broken" guarantee the existing
  // Worker-path tests already rely on, now verified for the fallback too.
  const compressed = await PDFDocument.load(bytes);
  expect(compressed.getPageCount()).toBe(4);
  expectNoUnexpectedErrors(errors);
});

test("compress (forced fallback): main thread stays responsive - no catastrophic multi-second stall", async ({ page }) => {
  test.setTimeout(60_000);
  await forceMainThreadFallback(page);
  await page.goto("/compress-pdf");
  await page.locator("#fi").setInputFiles(imageHeavyPdf);
  await expect(page.locator("#go")).toBeVisible();

  // requestAnimationFrame heartbeat: on a genuinely frozen main thread,
  // consecutive timestamps stop advancing for as long as the freeze
  // lasts. Before this phase's fix, an unforced (Worker) run on a real
  // image-heavy PDF measured a worst single gap around 280ms; the
  // unfixed fallback (parse with zero cooperative yields, a fully
  // synchronous per-image JPEG encode) measured gaps up to several
  // hundred ms with the majority of wall time spent stalled. This
  // threshold is intentionally set far above ordinary jank/GC-pause
  // noise (which this repo's own CI-timing investigation showed can
  // reach several hundred ms on a loaded test machine even on the
  // Worker path) - it exists to catch a real regression back to
  // "effectively hung for seconds", not to gate on precise responsiveness.
  const MAX_ACCEPTABLE_SINGLE_GAP_MS = 4000;

  await page.evaluate(() => {
    window.__frames = [];
    function tick(t) { window.__frames.push(t); window.__raf = requestAnimationFrame(tick); }
    window.__raf = requestAnimationFrame(tick);
  });

  await page.locator("#go").click();
  await page.waitForSelector('a.dl-link[download="image-heavy_compressed.pdf"]', { timeout: 45_000 });

  const { maxGapMs, frameCount } = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    const f = window.__frames;
    let maxGap = 0;
    for (let i = 1; i < f.length; i++) maxGap = Math.max(maxGap, f[i] - f[i - 1]);
    return { maxGapMs: maxGap, frameCount: f.length };
  });

  console.log(`[compress-fallback] longest single main-thread stall: ${maxGapMs.toFixed(1)}ms across ${frameCount} rAF frames`);
  // A cooperative fallback should never produce a stall anywhere near
  // this long - rAF should keep ticking (even if slowly) between every
  // image's encode. This is deliberately a loose ceiling, not a tight
  // performance assertion, so ordinary CI machine noise doesn't flake it.
  expect(maxGapMs).toBeLessThan(MAX_ACCEPTABLE_SINGLE_GAP_MS);
  // Some rAF activity must have been recorded at all - an empty/near-empty
  // array would itself indicate the page never became interactive, a
  // different failure mode this assertion also guards against.
  expect(frameCount).toBeGreaterThan(5);
});

test("compress (forced fallback): clicking Cancel actually stops the operation - no download, no success", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await forceMainThreadFallback(page);
  // 800ms per image gives an easy, deterministic multi-second window to
  // click Cancel in, regardless of how fast the underlying machine is.
  await injectPerImageDecodeDelay(page, 800);
  await page.goto("/compress-pdf");
  await page.locator("#fi").setInputFiles(imageHeavyPdf);
  await expect(page.locator("#go")).toBeVisible();

  const downloadEvents = [];
  page.on("download", (d) => downloadEvents.push(d));

  await page.locator("#go").click();
  // Cancel button becomes visible once TOOLS.compress's own click handler
  // body actually starts running (withToolOperation defers it to a
  // microtask, so it's not available synchronously right after .click()
  // returns).
  await expect(page.locator("#cancelCompress")).toBeVisible({ timeout: 5000 });
  // Wait for the first image's progress text too, so this is definitely
  // clicking Cancel mid-operation (during the first artificially-delayed
  // decode), not merely before it.
  await expect(page.locator("#out")).toContainText(/1 of 4/, { timeout: 5000 });
  await page.locator("#cancelCompress").click();

  // The operation must resolve to a "cancelled" outcome, not a success.
  await expect(page.locator("#out")).toContainText(/cancel/i, { timeout: 15_000 });

  // No result/download link should ever appear for a cancelled run.
  await expect(page.locator('a.dl-link[download="image-heavy_compressed.pdf"]')).toHaveCount(0);
  expect(downloadEvents.length).toBe(0);

  // Cancellation is expected to reject the in-flight operation - the
  // click handler's own catch block (TOOLS.compress) already treats a
  // CompressionCancelled error as a normal, non-error outcome, so no
  // unhandled rejection or page error should ever surface from this.
  expectNoUnexpectedErrors(errors);
});
