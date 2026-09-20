import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { homepageRuntime, runtimeForTool } = require("../build/runtime-manifest.js");
const registry = JSON.parse(readFileSync(resolve(ROOT, "seo/tools-registry.json"), "utf8"));
const additional = JSON.parse(readFileSync(resolve(ROOT, "seo/additional-tools.json"), "utf8"));
const tools = [...registry.tools, ...additional.tools];
const indexableTools = tools.filter((tool) =>
  tool.indexable !== false && (tool.status === "live" || tool.status === "landing-only")
);
const site = registry.site;
const staticPages = JSON.parse(readFileSync(resolve(ROOT, "seo/static-pages.json"), "utf8")).pages;

function htmlFor(file) {
  return readFileSync(resolve(ROOT, file), "utf8");
}

function routeFor(tool) {
  return "/" + tool.file.replace(/\.html$/, "");
}

function canonicalFor(tool) {
  return site.domain.replace(/\/$/, "") + routeFor(tool);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tagContent(html, pattern, label) {
  const matches = [...html.matchAll(pattern)];
  expect(matches.length, label).toBe(1);
  return matches[0][1];
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

describe("SEO registries and generated routes", () => {
  it("defines complete, unique metadata for every live tool", () => {
    const uniqueFields = ["slug", "file", "toolId", "title", "description"];
    for (const field of uniqueFields) {
      const values = tools.map((tool) => tool[field]);
      expect(values.every(Boolean), "missing " + field).toBe(true);
      expect(new Set(values).size, "duplicate " + field).toBe(values.length);
    }

    for (const tool of tools) {
      expect(tool.status, tool.slug + " status").toBeTruthy();
      expect(registry.categories[tool.category], tool.slug + " category").toBeTruthy();
      expect(existsSync(resolve(ROOT, tool.file)), tool.slug + " -> missing " + tool.file).toBe(true);
      expect(tool.title).not.toMatch(/coming soon/i);
      expect(tool.description).not.toMatch(/coming soon|in active development/i);
    }
  });

  it("keeps every related-tool reference valid", () => {
    const known = new Set(tools.map((tool) => tool.slug));
    for (const tool of tools) {
      for (const slug of tool.relatedSlugs || []) {
        expect(known.has(slug), tool.slug + " -> unknown related slug " + slug).toBe(true);
      }
    }
  });

  it("renders unique titles, descriptions, canonical URLs, robots, and social metadata", () => {
    const pages = [
      { file: "index.html", title: site.defaultTitle, description: site.defaultDescription, canonical: site.domain.replace(/\/$/, "") + "/" },
      ...indexableTools.map((tool) => ({ file: tool.file, title: tool.title, description: tool.description, canonical: canonicalFor(tool) }))
    ];
    const canonicals = [];

    for (const page of pages) {
      const html = htmlFor(page.file);
      expect(html).toContain("<title>" + escapeHtml(page.title) + "</title>");
      expect(html).toContain('<meta name="description" content="' + escapeHtml(page.description) + '">');
      expect(html).toContain('<meta name="robots" content="' + escapeHtml(site.robots) + '">');
      expect(html).toContain('<link rel="canonical" href="' + page.canonical + '">');
      expect(html).toContain('<meta property="og:url" content="' + page.canonical + '">');
      expect(html).toContain('<meta property="og:title" content="' + escapeHtml(page.title) + '">');
      expect(html).toContain('<meta property="og:description" content="' + escapeHtml(page.description) + '">');
      expect(html).toContain('<meta property="og:image" content="' + site.ogImage + '">');
      expect(html).toContain('<meta name="twitter:title" content="' + escapeHtml(page.title) + '">');
      expect(html).toContain('<meta name="twitter:description" content="' + escapeHtml(page.description) + '">');
      expect(html).toContain('<html lang="' + site.language + '">');
      canonicals.push(page.canonical);
    }

    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it("publishes only real canonical routes in sitemap.xml", () => {
    const sitemap = htmlFor("sitemap.xml");
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    const expected = [
      site.domain.replace(/\/$/, "") + "/",
      ...indexableTools.map(canonicalFor),
      ...staticPages.map((page) => site.domain.replace(/\/$/, "") + "/" + page.file.replace(/\.html$/, ""))
    ];
    expect(urls).toEqual(expected);
    expect(new Set(urls).size).toBe(urls.length);

    for (const url of urls) {
      const pathname = new URL(url).pathname;
      const file = pathname === "/" ? "index.html" : pathname.slice(1) + ".html";
      expect(existsSync(resolve(ROOT, file)), url + " has no generated page").toBe(true);
    }
  });

  it("keeps robots.txt aligned with the canonical sitemap", () => {
    expect(htmlFor("robots.txt")).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: " + site.domain.replace(/\/$/, "") + "/sitemap.xml\n"
    );
  });

  it("emits valid, truthful structured data for the homepage and every tool", () => {
    const homeBlocks = jsonLdBlocks(htmlFor("index.html"));
    expect(homeBlocks.map((block) => block["@type"])).toContain("SoftwareApplication");
    expect(homeBlocks.find((block) => block["@type"] === "SoftwareApplication").featureList)
      .toEqual(indexableTools.map((tool) => tool.name));

    for (const tool of indexableTools) {
      const blocks = jsonLdBlocks(htmlFor(tool.file));
      const types = blocks.map((block) => block["@type"]);
      expect(types, tool.slug).toContain("WebApplication");
      expect(types, tool.slug).toContain("BreadcrumbList");
      if (tool.faqs?.length) expect(types, tool.slug).toContain("FAQPage");
      // Phase 12: HowTo only when the page genuinely renders those steps
      // (tool.landing.howItWorks) - and when it does, the schema's own
      // step text must match the visible page 1:1, not just exist.
      if (tool.landing?.howItWorks?.length) {
        expect(types, tool.slug).toContain("HowTo");
        const howTo = blocks.find((block) => block["@type"] === "HowTo");
        expect(howTo.step.map((s) => s.name), tool.slug).toEqual(tool.landing.howItWorks.map((s) => s.title));
        expect(howTo.step.map((s) => s.text), tool.slug).toEqual(tool.landing.howItWorks.map((s) => s.desc));
      } else {
        expect(types, tool.slug).not.toContain("HowTo");
      }
      expect(types).not.toContain("Review");
      expect(types).not.toContain("AggregateRating");

      const app = blocks.find((block) => block["@type"] === "WebApplication");
      expect(app.url).toBe(canonicalFor(tool));
      expect(app.name).toBe(tool.name);
      expect(app.description).toBe(tool.description);
      expect(app.isAccessibleForFree).toBe(true);
      expect(app.offers.price).toBe("0");
    }
  });

  it("provides crawlable links to every live tool and keeps internal links resolvable", () => {
    const indexHtml = htmlFor("index.html");
    const directory = tagContent(
      indexHtml,
      /<!-- SEO_TOOL_DIRECTORY_START -->([\s\S]*?)<!-- SEO_TOOL_DIRECTORY_END -->/g,
      "generated all-tools directory"
    );
    for (const tool of indexableTools) {
      expect(directory).toContain('href="' + routeFor(tool) + '"');
    }

    // Static (non-tool) pages such as /privacy-policy are real routes too.
    const knownRoutes = new Set([
      "/",
      ...indexableTools.map(routeFor),
      ...staticPages.map((page) => "/" + page.file.replace(/\.html$/, ""))
    ]);
    for (const page of ["index.html", ...indexableTools.map((tool) => tool.file)]) {
      const html = htmlFor(page);
      for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
        const href = match[1];
        if (!href.startsWith("/") || href.startsWith("//")) continue;
        const route = href.split(/[?#]/)[0] || "/";
        expect(knownRoutes.has(route), page + " has unresolved link " + href).toBe(true);
      }
    }
  });

  it("keeps runtime route metadata generated from the same registry", () => {
    const routingSource = htmlFor("js/core/routing.js");
    const match = routingSource.match(/const TOOL_ROUTES = (\{.*\});/);
    expect(match).toBeTruthy();
    const routes = JSON.parse(match[1]);
    expect(Object.keys(routes)).toEqual(tools.map((tool) => tool.toolId));
    for (const tool of tools) {
      expect(routes[tool.toolId]).toEqual({
        path: routeFor(tool),
        title: tool.title,
        description: tool.description
      });
    }
  });

  it("preserves eager and lazy Phase 8 SRI protections in every generated page", () => {
    const hashes = [
      "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI",
      "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
      "sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt",
      "sha384-Z3REaz79l2IaAZqJsSABtTbhjgOUYyV3p90XNnAPCSHg3EMTz1fouunq9WZRtj3d",
      "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG",
      "sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz",
      "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw"
    ];
    const pages = [
      { file: "index.html", runtime: homepageRuntime() },
      ...indexableTools.map((tool) => ({ file: tool.file, runtime: runtimeForTool(tool.toolId) }))
    ];
    for (const page of pages) {
      const html = htmlFor(page.file);
      for (const hash of hashes) {
        expect(html, page.file + " missing " + hash).toContain(hash);
      }
      for (const library of page.runtime.libraries) {
        expect(html, page.file + " missing eager integrity for " + library.integrity)
          .toContain('integrity="' + library.integrity + '"');
      }
      expect((html.match(/crossorigin="anonymous"/g) || []).length)
        .toBeGreaterThanOrEqual(page.runtime.libraries.length);
      expect(html).toMatch(/s\.integrity\s*=\s*integrity/);
      expect(html).toMatch(/s\.crossOrigin\s*=\s*["']anonymous["']/);
    }
  });
});
