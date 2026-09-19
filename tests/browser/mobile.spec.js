import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs only under the "mobile" Playwright project (see playwright.config.js
// testMatch scoping) - a real touch-emulated, narrow-viewport device, not
// just a resized desktop window, so hover-dependent interactions genuinely
// aren't available here the way they are in workflows.spec.js.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("mobile nav: hamburger opens the menu, and a menu item navigates to its tool", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/");

  const hamburger = page.locator("#hamburgerBtn");
  await expect(hamburger).toBeVisible();

  await hamburger.click();
  const mobileMenu = page.locator("#mobileMenu");
  await expect(mobileMenu).toHaveClass(/open/);

  // "split" also appears a second time inside the collapsed "All PDF
  // Tools" mega-expansion (#mobileMega) - .first() is the direct top-level
  // shortcut button, the one a user taps without expanding that section.
  await mobileMenu.locator('[data-open="split"]').first().click();
  // dev-server.py serves the real cross-document navigation openTool()
  // performs as split-pdf.html directly - the clean, extensionless /split-
  // pdf URL is a production-only rewrite (_redirects, Netlify), not
  // something the local dev server also performs on in-app navigation.
  await expect(page).toHaveURL(/\/split-pdf(\.html)?$/);
  await expect(page.locator("#dz")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile upload uses the file-picker fallback (no drag-and-drop), processes, and downloads a real file", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/flatten-pdf");

  // No drag-and-drop on a touch device - the same hidden <input type="file">
  // under the dropzone is what a real mobile browser's "Choose File" tap
  // opens, and it's exactly what setInputFiles drives here too.
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#flist .file-card")).toHaveCount(1);

  await page.locator("#go").click();
  const downloadLink = page.locator('a.dl-link[download="valid_flattened.pdf"]');
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("valid_flattened.pdf");
  const path = await download.path();
  expect(statSync(path).size).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("mobile dialogs: the Support panel opens over the mobile viewport and its close control works", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/");

  await page.locator("#hamburgerBtn").click();
  await page.locator('#mobileMenu [data-open="donate"]').click();

  const panel = page.locator("#panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Support YOYOPDF", { exact: false })).toBeVisible();

  // The panel's own open motion (GSAP/CSS) keeps its bounding box moving
  // for a brief moment after becoming visible, which fails Playwright's
  // stricter-than-a-real-tap "stable for two frames" actionability check.
  // waitForTimeout lets that settle; force:true then covers any residual
  // sub-pixel motion, same as a real tap would land on this element fine
  // either way - this test's job is verifying the close *works*, not
  // asserting on the open animation itself.
  await page.waitForTimeout(400);
  await panel.locator(".panel-close").click({ force: true });
  await expect(page.locator("#overlay")).not.toHaveClass(/open/);
  expect(errors).toEqual([]);
});

// Phase 3 (Edit PDF pointer-based object manipulation, Fix 3): real Pixel 5
// touch-emulated coverage for js/editor/editor-objects.js's Pointer Events
// conversion. This device profile has hasTouch:true, but Playwright itself
// has no public API to synthesize a genuine hardware touch DRAG (only
// discrete taps via page.touchscreen) - the drag/resize steps below
// dispatch a real PointerEvent sequence with pointerType:"touch" directly,
// exercising the same pointerdown/pointermove/pointerup/setPointerCapture
// code path a real finger would drive. See tests/browser/edit-pdf-pointer.
// spec.js for the equivalent desktop-mouse coverage of the same code.
test("mobile Edit PDF: tap selects, touch-pointer drag moves, resize handle works, no scroll hijack", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  // A direct load of /edit-pdf runs TOOLS.edit() automatically, which
  // opens the #dz/#fi upload dropzone - no navigation click needed.
  await page.goto("/edit-pdf");
  await expect(page.locator("#dz")).toBeVisible({ timeout: 10_000 });
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });

  await page.locator('[data-action="text-tool"]').click();
  const pageWrap = page.locator(".editor-canvas-pages .editor-canvas-page").first();
  await expect(pageWrap).toBeVisible({ timeout: 10_000 });
  const pageBox = await pageWrap.boundingBox();
  // Tap well below the fixture's own title text (drawn near the top of
  // the page) - landing on top of real PDF text content places a
  // "replace this source text" object instead of a plain movable one
  // (see editor-objects.js's own comment on el's pointerdown handler:
  // such an object only starts dragging after its text edit is
  // committed), which isn't what this test is exercising.
  await page.touchscreen.tap(pageBox.x + 60, pageBox.y + pageBox.height * 0.7);

  const objectEl = page.locator(".editor-object").first();
  await expect(objectEl).toBeVisible({ timeout: 5000 });
  await expect(objectEl).toHaveClass(/is-selected/); // placement selects it

  const scrollYBefore = await page.evaluate(() => window.scrollY);

  // Move via a synthetic touch-type PointerEvent sequence.
  const before = await objectEl.evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  await page.evaluate(() => {
    const el = document.querySelector(".editor-object");
    const rect = el.getBoundingClientRect();
    const pointerId = 202;
    const startX = rect.left + rect.width / 2, startY = rect.top + rect.height / 2;
    function fire(type, x, y) {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId, pointerType: "touch", isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      }));
    }
    fire("pointerdown", startX, startY);
    fire("pointermove", startX + 20, startY + 15);
    fire("pointermove", startX + 40, startY + 30);
    fire("pointerup", startX + 40, startY + 30);
  });
  const afterMove = await objectEl.evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  expect(afterMove.left).toBeGreaterThan(before.left);
  expect(afterMove.top).toBeGreaterThan(before.top);

  // touch-action:none on .editor-object/.editor-object-handle
  // (css/editor-objects.css) means this drag must not have scrolled the
  // page - a real touchmove hijacked into a scroll gesture would move
  // window.scrollY instead of (or in addition to) the object.
  const scrollYAfter = await page.evaluate(() => window.scrollY);
  expect(scrollYAfter).toBe(scrollYBefore);

  // Resize via the se handle, same synthetic touch-pointer technique.
  const beforeResize = await objectEl.evaluate((el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) }));
  await page.evaluate(() => {
    const handle = document.querySelector(".editor-object.is-selected .editor-object-handle-se");
    const rect = handle.getBoundingClientRect();
    const pointerId = 203;
    const startX = rect.left + rect.width / 2, startY = rect.top + rect.height / 2;
    function fire(type, x, y) {
      handle.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId, pointerType: "touch", isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      }));
    }
    fire("pointerdown", startX, startY);
    fire("pointermove", startX + 25, startY + 20);
    fire("pointerup", startX + 25, startY + 20);
  });
  const afterResize = await objectEl.evaluate((el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) }));
  expect(afterResize.width).toBeGreaterThan(beforeResize.width);
  expect(afterResize.height).toBeGreaterThan(beforeResize.height);

  // /api/rating 404s under the plain dev server (only wired up under
  // `netlify dev`), logging two console entries per failed request - the
  // same known environment gap filtered the same way in
  // tests/browser/image-operations.spec.js. Scoped to this test only.
  const unexpected = errors.filter((e) => !e.includes("/api/rating") && !e.includes("Failed to load resource"));
  expect(unexpected).toEqual([]);
});
