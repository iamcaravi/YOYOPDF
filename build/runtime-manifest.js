"use strict";

const VERSION = "149";

const LIBRARIES = Object.freeze({
  pdfLib: Object.freeze({
    src: "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
    integrity: "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI"
  }),
  pdfJs: Object.freeze({
    src: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    integrity: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e"
  }),
  gsap: Object.freeze({
    src: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js",
    integrity: "sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt"
  }),
  scrollTrigger: Object.freeze({
    src: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js",
    integrity: "sha384-Z3REaz79l2IaAZqJsSABtTbhjgOUYyV3p90XNnAPCSHg3EMTz1fouunq9WZRtj3d"
  })
});

// One master order preserves the classic-script global dependency contract.
// Route profiles only filter this order; they can never reorder a dependency.
const SCRIPT_ORDER = Object.freeze([
  "js/core/i18n.js",
  "js/core/motion.js",
  "js/core/nav-menu.js",
  "js/core/hero-upload.js",
  "js/core/routing.js",
  "js/core/quick-actions.js",
  "js/core/panel.js",
  "js/core/ratings.js",
  "js/core/pdf-processing-utils.js",
  "js/core/pdf-crypto.js",
  "js/core/pptx-export.js",
  "js/core/pdf-canvas-widgets.js",
  "js/tools/misc-tools.js",
  "js/tools/pdf-page-tools-1.js",
  "js/tools/pdf-page-tools-2.js",
  "js/core/doc-export-builders.js",
  "js/tools/pdf-extra-tools.js",
  "js/core/xlsx-merge.js",
  "js/core/krutidev-to-unicode.js",
  "js/core/docx-reader.js",
  "js/tools/pdf-convert-tools.js",
  "js/tools/pdf-signing-tools.js",
  "js/tools/image-tools.js",
  "js/tools/pdf-security-tools.js",
  "js/app.js"
]);

const BASE_SCRIPTS = Object.freeze([
  "js/core/i18n.js",
  "js/core/motion.js",
  "js/core/nav-menu.js",
  "js/core/hero-upload.js",
  "js/core/routing.js",
  "js/core/quick-actions.js",
  "js/core/panel.js",
  "js/core/ratings.js",
  "js/core/pdf-processing-utils.js",
  "js/tools/misc-tools.js",
  "js/app.js"
]);

const PROFILE_SCRIPTS = Object.freeze({
  page1: Object.freeze(["js/core/pdf-canvas-widgets.js", "js/tools/pdf-page-tools-1.js"]),
  page2: Object.freeze(["js/core/pdf-canvas-widgets.js", "js/tools/pdf-page-tools-2.js"]),
  convert: Object.freeze(["js/core/pdf-canvas-widgets.js", "js/core/doc-export-builders.js", "js/core/xlsx-merge.js", "js/core/krutidev-to-unicode.js", "js/core/docx-reader.js", "js/tools/pdf-convert-tools.js"]),
  signing: Object.freeze(["js/core/pdf-canvas-widgets.js", "js/tools/pdf-signing-tools.js"]),
  image: Object.freeze(["js/tools/image-tools.js"]),
  security: Object.freeze(["js/core/pdf-crypto.js", "js/core/pdf-canvas-widgets.js", "js/tools/pdf-security-tools.js"]),
  extra: Object.freeze(["js/core/doc-export-builders.js", "js/tools/pdf-extra-tools.js"]),
  editor: Object.freeze([])
});

const TOOL_PROFILES = Object.freeze({
  merge:"page1", split:"page1", compress:"page1", rotate:"page1",
  deletepages:"page1", extractpages:"page1", reorder:"page1", addblank:"page1",
  pagenumbers:"page1", watermark:"page1",
  headerfooter:"page2", crop:"page2", invertpdf:"page2", organize:"page2",
  flatten:"page2", pdf2jpg:"page2", jpg2pdf:"page2",
  pdf2word:"convert", word2pdf:"convert", pdf2excel:"convert", pdf2pptx:"convert", excel2pdf:"convert", mergeexcel:"convert",
  sign:"signing", fillform:"signing",
  imgcompress:"image", imgresize:"image", imgcrop:"image", imgconvert:"image", imgwatermark:"image", imginvert:"image",
  protect:"security", unlock:"security", repair:"security",
  extractimages:"extra", pdfcounter:"extra", extracttext:"extra", pdfmetadata:"extra",
  pdf2md:"extra", resizepages:"extra", comparepdf:"extra", scantopdf:"extra",
  imgrotate:"image",
  edit:"editor"
});

const TOOL_EXTRA_SCRIPTS = Object.freeze({
  pdf2pptx: Object.freeze(["js/core/pptx-export.js"])
});

function orderedScripts(requested) {
  const wanted = new Set(requested);
  const ordered = SCRIPT_ORDER.filter((script) => wanted.has(script));
  if (ordered.length !== wanted.size) {
    const missing = [...wanted].filter((script) => !SCRIPT_ORDER.includes(script));
    throw new Error("Runtime manifest references scripts outside SCRIPT_ORDER: " + missing.join(", "));
  }
  return ordered.map((script) => `${script}?v=${VERSION}`);
}

function runtimeForTool(toolId) {
  const profile = TOOL_PROFILES[toolId];
  if (!profile) throw new Error("No runtime profile for tool: " + toolId);
  const scripts = orderedScripts([
    ...BASE_SCRIPTS,
    ...PROFILE_SCRIPTS[profile],
    ...(TOOL_EXTRA_SCRIPTS[toolId] || [])
  ]);
  const libraries = profile === "image"
    ? [LIBRARIES.gsap, LIBRARIES.scrollTrigger]
    : [LIBRARIES.pdfLib, LIBRARIES.pdfJs, LIBRARIES.gsap, LIBRARIES.scrollTrigger];
  return Object.freeze({ profile, scripts: Object.freeze(scripts), libraries: Object.freeze(libraries) });
}

function homepageRuntime() {
  return Object.freeze({
    profile: "homepage",
    scripts: Object.freeze(orderedScripts(SCRIPT_ORDER)),
    libraries: Object.freeze([LIBRARIES.pdfLib, LIBRARIES.pdfJs, LIBRARIES.gsap, LIBRARIES.scrollTrigger])
  });
}

module.exports = {
  LIBRARIES,
  SCRIPT_ORDER,
  TOOL_PROFILES,
  homepageRuntime,
  runtimeForTool
};