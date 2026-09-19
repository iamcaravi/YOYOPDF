import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Regression coverage for the "transparent PNG -> JPEG becomes black"
// bug: canvasContextForOutput() (js/tools/image-tools.js) is the shared
// helper both imgcompress and imgconvert now call before drawImage() so
// a JPEG-bound canvas is pre-filled white instead of defaulting to
// transparent-black. This loads the real source (classic <script>, no
// module wrapper) into a vm sandbox - same pattern as
// tests/editor-export.test.js - rather than re-implementing the logic,
// so the test actually exercises the shipped function.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(ROOT, "js/tools/image-tools.js"), "utf8");

function loadImageTools() {
  // TOOLS.imgcompress = function(){...} etc. are top-level assignments
  // onto TOOLS, so TOOLS must exist in the sandbox before the script
  // runs - none of the tool bodies themselves execute at load time, so
  // no other global needs to be stubbed just to load the file.
  const sandbox = { TOOLS: {} };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "image-tools.js" });
  return context;
}

function makeFakeCanvas(width, height) {
  const fillRectCalls = [];
  const fillStyleWrites = [];
  const ctx = {
    set fillStyle(v) { fillStyleWrites.push(v); },
    get fillStyle() { return fillStyleWrites.at(-1); },
    fillRect(...args) { fillRectCalls.push(args); },
  };
  return { canvas: { width, height, getContext: () => ctx }, fillRectCalls, fillStyleWrites };
}

describe("canvasContextForOutput (JPEG-transparency flatten helper)", () => {
  it("fills the whole canvas white before the caller draws, when the target format is JPEG", () => {
    const { canvasContextForOutput } = loadImageTools();
    const { canvas, fillRectCalls, fillStyleWrites } = makeFakeCanvas(40, 40);

    const ctx = canvasContextForOutput(canvas, "image/jpeg");

    expect(ctx).toBeTruthy();
    expect(fillStyleWrites).toContain("#fff");
    expect(fillRectCalls).toEqual([[0, 0, 40, 40]]);
  });

  it("does not touch the canvas background for formats that support real transparency (PNG, WebP)", () => {
    const { canvasContextForOutput } = loadImageTools();
    for (const mime of ["image/png", "image/webp"]) {
      const { canvas, fillRectCalls, fillStyleWrites } = makeFakeCanvas(40, 40);
      canvasContextForOutput(canvas, mime);
      expect(fillRectCalls, `${mime} should not fill the canvas`).toEqual([]);
      expect(fillStyleWrites, `${mime} should not set a fill color`).toEqual([]);
    }
  });

  it("is a no-op sizing-wise: fillRect always matches the canvas's own width/height, never a hardcoded size", () => {
    const { canvasContextForOutput } = loadImageTools();
    const { canvas, fillRectCalls } = makeFakeCanvas(123, 77);
    canvasContextForOutput(canvas, "image/jpeg");
    expect(fillRectCalls).toEqual([[0, 0, 123, 77]]);
  });
});
