import { defineConfig } from "vite";
import { cpSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, "dist");

// This is a classic-<script>-tag multi-page site, not an ES-module SPA:
// every top-level *.html file (the homepage, the 404 page, and one generated
// page per tool) is its own entry point. The js/core + js/tools scripts share
// one global scope by design, so Vite must not bundle or reorder them.
const htmlEntries = Object.fromEntries(
  readdirSync(__dirname)
    .filter((file) => file.endsWith(".html"))
    .map((file) => [file.slice(0, -".html".length), resolve(__dirname, file)])
);

const runtimeDirectories = ["js", "css", "assets"];
// ads.txt must be served from the site root (https://yoyopdf.com/ads.txt) and
// Netlify publishes only dist/, so it has to be copied here like the other
// root-level deployment files.
const deploymentFiles = ["_headers", "_redirects", "robots.txt", "sitemap.xml", "ads.txt"];

/**
 * Vite intentionally leaves classic script URLs unchanged and does not discover
 * assets referenced only from runtime-created <script>/<link> elements or a
 * Worker constructor. Copy those existing static trees after bundling so dist
 * is a complete deploy artifact while preserving the application's established
 * classic-script loading order and lazy-loading behavior.
 */
// css/site.css (Phase 12) is the one file under css/ that IS reachable
// from a real <link rel="stylesheet"> tag in every page's <head>, so Vite's
// own HTML processing already fingerprints/minifies it into dist/assets/
// (see the built <link> tags — one shared hashed file, not 35 copies).
// Every other css/*.css file (the editor stylesheets) is only ever loaded
// by a literal runtime string path (js/tools/misc-tools.js injecting
// <link> elements dynamically) that Vite's static HTML scan can't see, so
// those still need this raw, unprocessed copy — skipping just this one
// file avoids shipping both a hashed/minified copy and a dead, unreferenced
// raw duplicate of the same CSS.
const SKIP_RUNTIME_COPY = new Set([resolve(__dirname, "css", "site.css")]);

function copyClassicRuntime() {
  return {
    name: "copy-classic-runtime",
    apply: "build",
    closeBundle() {
      mkdirSync(outputDir, { recursive: true });
      for (const directory of runtimeDirectories) {
        cpSync(resolve(__dirname, directory), resolve(outputDir, directory), {
          recursive: true,
          force: true,
          filter: (src) => !SKIP_RUNTIME_COPY.has(src),
        });
      }
      for (const file of deploymentFiles) {
        copyFileSync(resolve(__dirname, file), resolve(outputDir, file));
      }
    },
  };
}

export default defineConfig({
  plugins: [copyClassicRuntime()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: htmlEntries,
    },
  },
});
