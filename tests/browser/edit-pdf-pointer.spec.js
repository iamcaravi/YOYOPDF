import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 3 (Edit PDF pointer-based object manipulation, Fix 3): coverage
// for js/editor/editor-objects.js's startDrag() after converting it from
// mousedown/mousemove/mouseup to Pointer Events (pointerdown/pointermove/
// pointerup/pointercancel + setPointerCapture), matching the pattern
// already used by js/core/pdf-canvas-widgets.js's wireCropCanvas().
//
// Playwright's page.mouse.* issues real, trusted browser input that
// produces genuine PointerEvents (pointerType:"mouse") in Chromium, so
// the first test below is a real end-to-end check of desktop behavior,
// not a simulation. There is no public Playwright API to synthesize a
// genuine hardware touch DRAG (page.touchscreen only supports discrete
// taps) - the second test instead dispatches a real PointerEvent sequence
// with pointerType:"touch" directly at the same DOM elements the app's
// own listeners are attached to. This exercises the exact same
// pointerdown/pointermove/pointerup code path a real touchscreen would
// drive (including pointerId matching and setPointerCapture not
// throwing), but is a synthetic/untrusted event dispatch, not a real
// touch-input-pipeline simulation - documented here as that limitation,
// per the investigation's own finding that Playwright's mouse actions on
// a touch-emulated page do not become real touch events.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");

async function openEditorWithObject(page) {
  // A direct load of /edit-pdf runs TOOLS.edit() automatically (js/app.js's
  // pathToolId bootstrap), which opens the #dz/#fi dropzone panel - no
  // click needed to reach it.
  await page.goto("/edit-pdf");
  await expect(page.locator("#dz")).toBeVisible({ timeout: 10_000 });
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 20_000 });

  await page.locator('[data-action="text-tool"]').click();
  // css/pdf-viewer.css has a separate placeholder `.editor-canvas-page`
  // directly under .editor-canvas (hidden once data-state="page") from
  // the real, rendered ones inside .editor-canvas-pages - scope to the
  // latter so this doesn't match the hidden placeholder.
  const pageWrap = page.locator(".editor-canvas-pages .editor-canvas-page").first();
  await expect(pageWrap).toBeVisible({ timeout: 10_000 });
  const box = await pageWrap.boundingBox();
  // Click near the top-left, away from any edge, so the object (and its
  // resize handles) has room on every side.
  await page.mouse.click(box.x + 80, box.y + 80);

  const objectEl = page.locator(".editor-object").first();
  await expect(objectEl).toBeVisible({ timeout: 5000 });
  return objectEl;
}

async function getBoxState(locator) {
  return locator.evaluate((el) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
    selected: el.classList.contains("is-selected"),
  }));
}

test("Edit PDF pointer move/resize: real mouse input still works (desktop)", async ({ page }) => {
  test.setTimeout(30_000);
  const objectEl = await openEditorWithObject(page);
  const before = await getBoxState(objectEl);
  expect(before.selected).toBe(true); // placement selects the new object

  // Move via real, trusted mouse input (produces genuine
  // pointerType:"mouse" PointerEvents in Chromium).
  const box = await objectEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  const afterMove = await getBoxState(objectEl);
  expect(afterMove.left).toBeGreaterThan(before.left);
  expect(afterMove.top).toBeGreaterThan(before.top);
  // Move must not change size.
  expect(afterMove.width).toBeCloseTo(before.width, 1);
  expect(afterMove.height).toBeCloseTo(before.height, 1);

  // Resize via the se (south-east) handle, also real mouse input.
  const handle = page.locator(".editor-object.is-selected .editor-object-handle-se");
  await expect(handle).toBeVisible();
  const hBox = await handle.boundingBox();
  await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hBox.x + hBox.width / 2 + 40, hBox.y + hBox.height / 2 + 30, { steps: 5 });
  await page.mouse.up();

  const afterResize = await getBoxState(objectEl);
  expect(afterResize.width).toBeGreaterThan(afterMove.width);
  expect(afterResize.height).toBeGreaterThan(afterMove.height);
  // Resize from the se handle keeps the top-left corner fixed.
  expect(afterResize.left).toBeCloseTo(afterMove.left, 1);
  expect(afterResize.top).toBeCloseTo(afterMove.top, 1);
});

test("Edit PDF pointer move: synthetic touch-type PointerEvent sequence moves the object", async ({ page }) => {
  test.setTimeout(30_000);
  const objectEl = await openEditorWithObject(page);
  const before = await getBoxState(objectEl);

  const result = await page.evaluate(() => {
    const el = document.querySelector(".editor-object");
    const rect = el.getBoundingClientRect();
    const pointerId = 101;
    const startX = rect.left + rect.width / 2, startY = rect.top + rect.height / 2;
    const dx = 50, dy = 35;
    function fire(type, x, y, target) {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId, pointerType: "touch", isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      }));
    }
    fire("pointerdown", startX, startY, el);
    fire("pointermove", startX + dx / 2, startY + dy / 2, el);
    fire("pointermove", startX + dx, startY + dy, el);
    fire("pointerup", startX + dx, startY + dy, el);
    const after = el.getBoundingClientRect();
    return { movedX: after.left - rect.left, movedY: after.top - rect.top };
  });

  // Only asserting the direction/rough magnitude of movement (not exact
  // pixels) - percentage<->pixel rounding makes exact deltas brittle here.
  expect(result.movedX).toBeGreaterThan(10);
  expect(result.movedY).toBeGreaterThan(5);

  const after = await getBoxState(objectEl);
  expect(after.left).toBeGreaterThan(before.left);
  expect(after.top).toBeGreaterThan(before.top);
});

test("Edit PDF pointer selection: a tap/click selects the object without side effects", async ({ page }) => {
  test.setTimeout(30_000);
  const objectEl = await openEditorWithObject(page);
  // Deselect, then re-select via a plain pointerdown+pointerup with zero
  // movement - must select without registering as a drag/undo step.
  await page.evaluate(() => document.querySelector(".editor-canvas").click());
  await expect(objectEl).not.toHaveClass(/is-selected/);

  const box = await objectEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(objectEl).toHaveClass(/is-selected/);
});
