import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 3 (Edit PDF initialization race fixes): regression coverage for
// two distinct races in js/tools/misc-tools.js's loadEditorAssets()/
// prepareEditFile() and js/editor/editor-layout.js's setupAdaptiveFit() -
// see the Phase 3 investigation for the original evidence these tests
// encode.
//
// The real Edit PDF flow (unlike the stale .editor-shell-immediately-
// after-goto assumption in tests/browser/large-document.spec.js and
// tests/browser/workflows.spec.js) starts at an upload dropzone: a direct
// load of /edit-pdf runs TOOLS.edit() automatically (js/app.js's own
// pathToolId bootstrap), which opens the #dz/#fi dropzone panel - no
// click needed to reach it.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");

async function openEditUpload(page) {
  await page.goto("/edit-pdf");
  // #fi (the actual file input) is intentionally visually hidden - the
  // styled #dz dropzone is what's visible; setInputFiles() works on #fi
  // directly regardless of its own visibility.
  await expect(page.locator("#dz")).toBeVisible({ timeout: 10_000 });
}

test.describe("Edit PDF — CSS readiness race (Fix 1)", () => {
  test("editor-canvas geometry is correct once the document is ready, even when CSS is slow", async ({ page, context }) => {
    test.setTimeout(30_000);
    // Delay only the editor's own workspace stylesheet - .editor-canvas's
    // real flex-based size comes from css/editor-workspace.css's
    // .editor-body/.editor-canvas rules (see loadEditorAssets()'s own
    // comment). Everything else loads at normal speed.
    await context.route("**/css/editor-workspace.css*", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });

    await openEditUpload(page);
    await page.locator("#fi").setInputFiles(validPdf);

    // Wait for the app to consider the document ready (mirrors what a real
    // user/other code would treat as "loaded").
    await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });

    // At that exact moment, the canvas must already reflect the real CSS
    // (flex layout), not the browser's unstyled default box - this is the
    // condition Fix 1 (awaiting CSS load/error before resolving
    // editorAssetsLoadPromise) is meant to guarantee.
    const { display, flexGrow, overflowY } = await page.locator(".editor-canvas").evaluate((el) => {
      const s = getComputedStyle(el);
      return { display: s.display, flexGrow: s.flexGrow, overflowY: s.overflowY };
    });
    expect(display).toBe("flex");
    expect(flexGrow).toBe("1");
    expect(overflowY).toBe("auto");
  });

  test("editor CSS actually applies under normal (non-delayed) conditions too", async ({ page }) => {
    test.setTimeout(30_000);
    await openEditUpload(page);
    await page.locator("#fi").setInputFiles(validPdf);
    await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });
    const flexGrow = await page.locator(".editor-canvas").evaluate((el) => getComputedStyle(el).flexGrow);
    expect(flexGrow).toBe("1");
  });
});

test.describe("Edit PDF — redundant initial-fit call (Fix 2)", () => {
  async function countInitialReadableCalls(page) {
    // Polls for window.ZoomManager to appear (it's lazy-script-loaded) and
    // wraps initialReadable() to count real invocations - installed via
    // addInitScript so it's in place before misc-tools.js/editor-canvas.js
    // ever get a chance to call it.
    await page.addInitScript(() => {
      window.__initialReadableCalls = 0;
      const poll = setInterval(() => {
        if (window.ZoomManager && !window.ZoomManager.__wrapped) {
          const real = window.ZoomManager.initialReadable;
          window.ZoomManager.initialReadable = function (...args) {
            window.__initialReadableCalls++;
            return real.apply(this, args);
          };
          window.ZoomManager.__wrapped = true;
          clearInterval(poll);
        }
      }, 5);
    });
  }

  test("initialReadable() runs exactly once per document initialization (normal load)", async ({ page }) => {
    test.setTimeout(30_000);
    await countInitialReadableCalls(page);
    await openEditUpload(page);
    await page.locator("#fi").setInputFiles(validPdf);
    await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });
    // Give the old (now-guarded) deferred setTimeout(0) path a real chance
    // to fire if the guard were broken, before asserting the final count.
    await page.waitForTimeout(250);
    const calls = await page.evaluate(() => window.__initialReadableCalls);
    expect(calls).toBe(1);
  });

  test("initialReadable() still runs exactly once under 4x CPU throttling", async ({ page, context }) => {
    test.setTimeout(45_000);
    await countInitialReadableCalls(page);
    const cdp = await context.newCDPSession(page);
    await openEditUpload(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.locator("#fi").setInputFiles(validPdf);
    await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const calls = await page.evaluate(() => window.__initialReadableCalls);
    expect(calls).toBe(1);
  });

  test("initialReadable() runs exactly once across repeated fresh loads", async ({ browser }) => {
    test.setTimeout(60_000);
    for (let i = 0; i < 3; i++) {
      const page = await browser.newPage();
      await countInitialReadableCalls(page);
      await openEditUpload(page);
      await page.locator("#fi").setInputFiles(validPdf);
      await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(250);
      const calls = await page.evaluate(() => window.__initialReadableCalls);
      expect(calls, `run ${i + 1}`).toBe(1);
      await page.close();
    }
  });
});
