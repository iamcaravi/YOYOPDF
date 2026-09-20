import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findUnprotectedThirdPartyScripts } from "./helpers/third-party-scripts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { homepageRuntime, runtimeForTool } = require("../build/runtime-manifest.js");
const registry = JSON.parse(readFileSync(resolve(ROOT, "seo/tools-registry.json"), "utf8"));
const additional = JSON.parse(readFileSync(resolve(ROOT, "seo/additional-tools.json"), "utf8"));
const tools = [...registry.tools, ...additional.tools].filter((tool) => tool.status !== "planned");
const staticPages = JSON.parse(readFileSync(resolve(ROOT, "seo/static-pages.json"), "utf8")).pages;
const appHtmlFiles = ["index.html", ...tools.map((tool) => tool.file)];
const expectedHtmlFiles = [...appHtmlFiles, ...staticPages.map((page) => page.file), "404.html"].sort();
const actualHtmlFiles = readdirSync(ROOT).filter((file) => file.endsWith(".html")).sort();

function scriptTags(html) {
  const out = [];
  const re = /<script\s+([^>]*\bsrc="([^"]+)"[^>]*)><\/script>/g;
  let match;
  while ((match = re.exec(html))) out.push({ attributes: match[1], src: match[2] });
  return out;
}

function localScriptSrcs(html) {
  return scriptTags(html).filter((tag) => !/^https?:\/\//.test(tag.src)).map((tag) => tag.src);
}

function externalScriptTags(html) {
  return scriptTags(html).filter((tag) => /^https?:\/\//.test(tag.src));
}

describe("static route integrity", () => {
  it("has exactly the homepage, every registered tool page, the static pages, and the 404 page", () => {
    expect(actualHtmlFiles).toEqual(expectedHtmlFiles);
  });

  const indexHtml = readFileSync(resolve(ROOT, "index.html"), "utf8");
  const indexScripts = localScriptSrcs(indexHtml);
  const homepage = homepageRuntime();

  it("index.html uses the generated homepage runtime and every local script exists", () => {
    expect(indexScripts).toEqual(homepage.scripts);
    for (const src of indexScripts) {
      expect(existsSync(resolve(ROOT, src.split("?")[0])), "missing script file: " + src).toBe(true);
    }
  });

  it("loads js/app.js last on every app route", () => {
    expect(indexScripts.at(-1).split("?")[0]).toBe("js/app.js");
    for (const tool of tools) {
      const scripts = localScriptSrcs(readFileSync(resolve(ROOT, tool.file), "utf8"));
      expect(scripts.at(-1).split("?")[0], tool.file).toBe("js/app.js");
    }
  });

  for (const tool of tools) {
    it(tool.file + " loads its generated runtime profile in dependency order", () => {
      const html = readFileSync(resolve(ROOT, tool.file), "utf8");
      const runtime = runtimeForTool(tool.toolId);
      expect(localScriptSrcs(html)).toEqual(runtime.scripts);
      expect(externalScriptTags(html).map((tag) => tag.src)).toEqual(runtime.libraries.map((library) => library.src));
      for (const src of runtime.scripts) {
        expect(existsSync(resolve(ROOT, src.split("?")[0])), "missing script file: " + src).toBe(true);
      }
    });
  }

  it("keeps SRI and anonymous CORS on every eager third-party script", () => {
    // The ONLY exception is the Google-managed AdSense loader on the
    // homepage (exact approved URL, async, crossorigin) - see the rule and
    // its rationale in tests/helpers/third-party-scripts.js. Every other
    // external script, on every page, still needs SRI.
    for (const file of appHtmlFiles) {
      expect(findUnprotectedThirdPartyScripts(file, readFileSync(resolve(ROOT, file), "utf8")), file).toEqual([]);
    }
  });

  it("removes PDF-only scripts and libraries from image-only routes", () => {
    const imageTool = tools.find((tool) => tool.toolId === "imginvert");
    const html = readFileSync(resolve(ROOT, imageTool.file), "utf8");
    const scripts = localScriptSrcs(html);
    expect(scripts).toContain("js/tools/image-tools.js?v=130");
    expect(scripts).not.toContain("js/core/pdf-canvas-widgets.js?v=130");
    expect(externalScriptTags(html).map((tag) => tag.src)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("pdf-lib"),
      expect.stringContaining("pdf.min.js")
    ]));
    expect(scripts.length).toBeLessThan(indexScripts.length);
  });

  it("serves unknown routes through a dedicated noindex 404 page", () => {
    const notFound = readFileSync(resolve(ROOT, "404.html"), "utf8");
    expect(notFound).toContain('<meta name="robots" content="noindex,follow">');
    expect(notFound).toContain("<h1");
    expect(notFound).toContain('href="/"');
    expect(localScriptSrcs(notFound)).toEqual([]);

    const redirects = readFileSync(resolve(ROOT, "_redirects"), "utf8");
    for (const tool of tools) {
      const route = "/" + tool.file.replace(/\.html$/, "");
      expect(redirects).toContain(route + "  /" + tool.file + "  200");
    }
    expect(redirects.trimEnd().endsWith("/*  /404.html  404")).toBe(true);
  });
});