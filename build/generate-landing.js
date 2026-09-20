const fs = require("fs");
const path = require("path");
const { homepageRuntime, runtimeForTool } = require("./runtime-manifest.js");
const adsense = require("./adsense-config.js");

const ROOT = path.join(__dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

const registry = readJson("seo/tools-registry.json");
const additional = readJson("seo/additional-tools.json");
// Standalone, hand-written, indexable pages that are not tools (currently the
// crawlable Privacy Policy). Only their metadata lives here: the generator
// adds them to sitemap.xml and _redirects; the HTML itself is a normal
// source file (like 404.html), verified by build/verify-dist.js and the tests.
const staticPages = readJson("seo/static-pages.json").pages;
const site = registry.site;

const additionalNormalized = additional.tools.map((tool) => ({
  ...tool,
  landing: {
    ...(tool.landing || {}),
    hero: {
      ...(tool.landing?.hero || {}),
      valueProp: tool.landing?.hero?.valueProp || tool.heroValueProp
    }
  }
}));

const ALL_TOOLS = [...registry.tools, ...additionalNormalized];
const TOOL_BY_SLUG = new Map(ALL_TOOLS.map((tool) => [tool.slug, tool]));
const INDEXABLE_TOOLS = ALL_TOOLS.filter((tool) =>
  tool.indexable !== false && (tool.status === "live" || tool.status === "landing-only")
);
const GENERATED_TOOLS = ALL_TOOLS.filter((tool) => tool.status !== "planned");

function routeFor(tool) {
  return "/" + tool.file.replace(/\.html$/i, "");
}

function canonicalFor(tool) {
  return site.domain.replace(/\/$/, "") + routeFor(tool);
}

function staticRouteFor(page) {
  return "/" + page.file.replace(/\.html$/i, "");
}

function staticCanonicalFor(page) {
  return site.domain.replace(/\/$/, "") + staticRouteFor(page);
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validateRegistry() {
  const requiredSiteFields = ["name", "domain", "language", "locale", "robots", "defaultTitle", "defaultDescription", "ogImage"];
  for (const field of requiredSiteFields) {
    if (!site[field]) throw new Error("Missing site metadata: " + field);
  }

  // site.lastmod feeds every sitemap <lastmod> (see renderSitemap). It must
  // be a real YYYY-MM-DD calendar date, checked without consulting the
  // current date - so this validation can never start failing just because
  // time has passed. Round-tripping through Date.UTC rejects impossible
  // dates like 2026-02-30 that a format-only regex would accept.
  const lastmod = site.lastmod;
  if (typeof lastmod !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) {
    throw new Error("Invalid site.lastmod in seo/tools-registry.json: expected a YYYY-MM-DD string, got " + JSON.stringify(lastmod));
  }
  const [lmYear, lmMonth, lmDay] = lastmod.split("-").map(Number);
  const lmDate = new Date(Date.UTC(lmYear, lmMonth - 1, lmDay));
  if (lmDate.getUTCFullYear() !== lmYear || lmDate.getUTCMonth() !== lmMonth - 1 || lmDate.getUTCDate() !== lmDay) {
    throw new Error("Invalid site.lastmod in seo/tools-registry.json: " + lastmod + " is not a real calendar date");
  }

  const seen = {
    slug: new Set(),
    file: new Set(),
    route: new Set(),
    toolId: new Set(),
    title: new Set(),
    description: new Set()
  };
  for (const tool of ALL_TOOLS) {
    for (const field of ["slug", "file", "toolId", "status", "category", "name", "title", "description", "h1"]) {
      if (!tool[field]) throw new Error("Tool " + (tool.slug || "(unknown)") + " is missing " + field);
    }
    if (!registry.categories[tool.category]) {
      throw new Error("Tool " + tool.slug + " has unknown category " + tool.category);
    }
    if (!/^[a-z0-9-]+\.html$/.test(tool.file)) {
      throw new Error("Tool " + tool.slug + " has an unsafe or unsupported file path: " + tool.file);
    }
    if (!["live", "landing-only", "planned"].includes(tool.status)) {
      throw new Error("Tool " + tool.slug + " has unsupported status " + tool.status);
    }

    const values = {
      slug: tool.slug,
      file: tool.file,
      route: routeFor(tool),
      toolId: tool.toolId,
      title: tool.title,
      description: tool.description
    };
    for (const [kind, value] of Object.entries(values)) {
      if (seen[kind].has(value)) throw new Error("Duplicate tool " + kind + ": " + value);
      seen[kind].add(value);
    }

    for (const relatedSlug of tool.relatedSlugs || []) {
      if (!TOOL_BY_SLUG.has(relatedSlug)) {
        throw new Error("Tool " + tool.slug + " references unknown related tool " + relatedSlug);
      }
    }
  }

  // Static (non-tool) pages share the route/file/title/description
  // namespace with the tools, so a collision is a build error, not a
  // silently shadowed page.
  for (const page of staticPages) {
    for (const field of ["slug", "file", "title", "description"]) {
      if (!page[field]) throw new Error("Static page " + (page.slug || "(unknown)") + " is missing " + field);
    }
    if (!/^[a-z0-9-]+\.html$/.test(page.file)) {
      throw new Error("Static page " + page.slug + " has an unsafe or unsupported file path: " + page.file);
    }
    const values = {
      slug: page.slug,
      file: page.file,
      route: staticRouteFor(page),
      title: page.title,
      description: page.description
    };
    for (const [kind, value] of Object.entries(values)) {
      if (seen[kind] && seen[kind].has(value)) throw new Error("Duplicate static page " + kind + ": " + value);
      if (seen[kind]) seen[kind].add(value);
    }
  }
}

validateRegistry();

const RAW_TEMPLATE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const ROUTING_TEMPLATE = fs.readFileSync(path.join(ROOT, "js/core/routing.js"), "utf8");
const SOFTWAREAPP_JSONLD_RE = /<script type="application\/ld\+json">\s*\{[\s\S]*?"@type":\s*"SoftwareApplication"[\s\S]*?<\/script>\s*/;
const FAQPAGE_JSONLD_RE = /<script type="application\/ld\+json">\s*\{[\s\S]*?"@type":\s*"FAQPage"[\s\S]*?<\/script>\s*/;
const DIRECTORY_RE = /<!-- SEO_TOOL_DIRECTORY_START -->[\s\S]*?<!-- SEO_TOOL_DIRECTORY_END -->/;
const TOOL_ROUTES_RE = /\/\* SEO_TOOL_ROUTES_START \*\/[\s\S]*?\/\* SEO_TOOL_ROUTES_END \*\//;
const RUNTIME_LIBRARIES_RE = /<!-- RUNTIME_LIBRARIES_START -->[\s\S]*?<!-- RUNTIME_LIBRARIES_END -->/;
const RUNTIME_SCRIPTS_RE = /<!-- RUNTIME_SCRIPTS_START -->[\s\S]*?<!-- RUNTIME_SCRIPTS_END -->/;
// The AdSense loader (build/adsense-config.js) is emitted on every AdSense-enabled page:
// the homepage and every generated tool page. index.html carries a START/END marker pair
// (outside the runtime-library markers, so renderRuntime() can never delete it);
// renderHomepage() fills it and renderTool() inherits it from the homepage template.
// 404.html and the static pages (privacy-policy.html) are separate files that never
// contain it. The strict nonce-based CSP for these pages is applied by the Edge Function
// netlify/edge-functions/csp-nonce.js (see _headers).
const ADSENSE_BLOCK_RE = /<!-- ADSENSE_LOADER_START -->[\s\S]*?<!-- ADSENSE_LOADER_END -->/;

function replaceRequired(input, pattern, replacement, label) {
  let count = 0;
  const out = input.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  if (count !== 1) throw new Error(label + " replacement count was " + count + ", expected 1");
  return out;
}

function jsonLd(data) {
  return '<script type="application/ld+json">\n' + JSON.stringify(data, null, 2) + "\n</script>\n";
}

function renderToolDirectory() {
  const categories = Object.entries(registry.categories)
    .sort((a, b) => a[1].order - b[1].order);

  const groups = categories.map(([category, details]) => {
    const tools = INDEXABLE_TOOLS
      .filter((tool) => tool.category === category)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!tools.length) return "";
    return [
      '      <div class="seo-tool-directory-group">',
      "        <h3>" + esc(details.label) + "</h3>",
      "        <ul>",
      tools.map((tool) =>
        '          <li><a href="' + esc(routeFor(tool)) + '">' + esc(tool.name) + "</a></li>"
      ).join("\n"),
      "        </ul>",
      "      </div>"
    ].join("\n");
  }).filter(Boolean).join("\n");

  return [
    "<!-- SEO_TOOL_DIRECTORY_START -->",
    '<section class="seo-tool-directory" aria-labelledby="seo-tool-directory-title">',
    '  <div class="seo-tool-directory-inner">',
    '    <div class="seo-tool-directory-head">',
    '      <h2 id="seo-tool-directory-title" data-i18n="home.exploreYoyopdfTools">Explore YOYOPDF Tools</h2>',
    '      <a class="seo-tool-directory-viewall" href="#tools" data-i18n="home.viewAllToolsArrow">View all tools &rarr;</a>',
    "    </div>",
    '    <nav class="seo-tool-directory-groups" aria-label="All YOYOPDF tools">',
    groups,
    "    </nav>",
    "  </div>",
    "</section>",
    "<!-- SEO_TOOL_DIRECTORY_END -->"
  ].join("\n");
}

function homepageSoftwareSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: site.name,
    url: site.domain.replace(/\/$/, "") + "/",
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any (Web Browser)",
    description: site.defaultDescription,
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD"
    },
    featureList: INDEXABLE_TOOLS.map((tool) => tool.name)
  };
}

function renderRuntime(template, runtime, label) {
  // defer (not async): every one of these classic, non-module scripts
  // shares one global scope and depends on running in exactly this
  // relative order (see the RUNTIME_SCRIPTS load-order comment in
  // index.html - js/app.js's own top-level IIFEs must run last). defer
  // preserves that exact ordering guarantee while letting the browser
  // fetch every script IN PARALLEL and keep parsing/painting the rest of
  // the page instead of blocking on each one sequentially - a real,
  // measured root cause of the tool-opening flash: with plain blocking
  // <script src> tags, the parser (and therefore first paint, and every
  // later script's own fetch) couldn't even begin until each earlier one
  // had downloaded and run, one after another.
  const libraryBlock = [
    "<!-- RUNTIME_LIBRARIES_START -->",
    ...runtime.libraries.map((library) => `<script defer src="${library.src}" integrity="${library.integrity}" crossorigin="anonymous"></script>`),
    "<!-- RUNTIME_LIBRARIES_END -->"
  ].join("\n");
  const scriptBlock = [
    "<!-- RUNTIME_SCRIPTS_START -->",
    ...runtime.scripts.map((src) => `<script defer src="${src}"></script>`),
    "<!-- RUNTIME_SCRIPTS_END -->"
  ].join("\n");
  let out = replaceRequired(template, RUNTIME_LIBRARIES_RE, libraryBlock, label + " runtime libraries");
  out = replaceRequired(out, RUNTIME_SCRIPTS_RE, scriptBlock, label + " runtime scripts");
  return out;
}
function renderAdSenseBlock() {
  return [
    "<!-- ADSENSE_LOADER_START -->",
    "<!-- Google AdSense loader, generated from build/adsense-config.js for the homepage and every tool page",
    "     (never privacy-policy.html or 404.html). No ad units/containers exist yet. Google-managed script, so no",
    "     SRI. It executes only under the nonce-based CSP that netlify/edge-functions/csp-nonce.js sets for these",
    "     pages; the strict static policy in _headers blocks it (fail closed). -->",
    adsense.ADSENSE_SCRIPT_TAG,
    "<!-- ADSENSE_LOADER_END -->"
  ].join("\n");
}
function renderHomepage(template) {
  const homeUrl = site.domain.replace(/\/$/, "") + "/";
  let out = template;
  out = replaceRequired(out, /<html lang="[^"]+">/, '<html lang="' + esc(site.language) + '">', "html lang");
  out = replaceRequired(out, /<title>[^<]*<\/title>/, "<title>" + esc(site.defaultTitle) + "</title>", "homepage title");
  out = replaceRequired(out, /<meta name="description" content="[^"]*">/, '<meta name="description" content="' + esc(site.defaultDescription) + '">', "homepage description");
  out = replaceRequired(out, /<meta name="robots" content="[^"]*">/, '<meta name="robots" content="' + esc(site.robots) + '">', "homepage robots");
  out = replaceRequired(out, /<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="' + esc(homeUrl) + '">', "homepage canonical");
  out = replaceRequired(out, /<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + esc(homeUrl) + '">', "homepage og:url");
  out = replaceRequired(out, /<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + esc(site.defaultTitle) + '">', "homepage og:title");
  out = replaceRequired(out, /<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + esc(site.defaultDescription) + '">', "homepage og:description");
  out = replaceRequired(out, /<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="' + esc(site.ogImage) + '">', "homepage og:image");
  out = replaceRequired(out, /<meta property="og:locale" content="[^"]*">/, '<meta property="og:locale" content="' + esc(site.locale) + '">', "homepage og:locale");
  out = replaceRequired(out, /<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + esc(site.defaultTitle) + '">', "homepage twitter:title");
  out = replaceRequired(out, /<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + esc(site.defaultDescription) + '">', "homepage twitter:description");
  out = replaceRequired(out, /<meta name="twitter:image" content="[^"]*">/, '<meta name="twitter:image" content="' + esc(site.ogImage) + '">', "homepage twitter:image");
  out = replaceRequired(out, SOFTWAREAPP_JSONLD_RE, jsonLd(homepageSoftwareSchema()), "homepage SoftwareApplication schema");
  out = replaceRequired(out, DIRECTORY_RE, renderToolDirectory(), "tool directory");
  out = replaceRequired(out, ADSENSE_BLOCK_RE, () => renderAdSenseBlock(), "AdSense loader block");
  out = renderRuntime(out, homepageRuntime(), "homepage");
  return out;
}

const HOMEPAGE = renderHomepage(RAW_TEMPLATE);

function renderSeoSection(tool) {
  const landing = tool.landing || {};
  const blocks = [];

  if (landing.whyUse?.points?.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>Why use " + esc(tool.name) + "?</h2>",
      '    <p class="tool-seo-intro">' + esc(landing.whyUse.intro || "") + "</p>",
      '    <div class="tool-seo-grid">' + landing.whyUse.points.map((point) =>
        '\n      <div class="tool-seo-card"><h3>' + esc(point.title) + "</h3><p>" + esc(point.desc) + "</p></div>"
      ).join("") + "\n    </div>",
      "  </div>"
    ].join("\n"));
  }

  if (landing.howItWorks?.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>How it works</h2>",
      '    <div class="tool-seo-steps">' + landing.howItWorks.map((step) =>
        '\n      <div class="tool-seo-step"><h3>' + esc(step.title) + "</h3><p>" + esc(step.desc) + "</p></div>"
      ).join("") + "\n    </div>",
      "  </div>"
    ].join("\n"));
  }

  if (landing.keyFeatures?.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>Key features</h2>",
      '    <div class="tool-seo-grid">' + landing.keyFeatures.map((feature) =>
        '\n      <div class="tool-seo-card"><h3>' + esc(feature.title) + "</h3><p>" + esc(feature.desc) + "</p></div>"
      ).join("") + "\n    </div>",
      "  </div>"
    ].join("\n"));
  }

  if (landing.useCases?.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>Who uses " + esc(tool.name) + "?</h2>",
      '    <div class="tool-seo-grid">' + landing.useCases.map((useCase) =>
        '\n      <div class="tool-seo-card"><h3>' + esc(useCase.title) + "</h3><p>" + esc(useCase.desc) + "</p></div>"
      ).join("") + "\n    </div>",
      "  </div>"
    ].join("\n"));
  }

  if (tool.faqs?.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>Frequently asked questions</h2>",
      tool.faqs.map((faq) =>
        '    <details class="tool-seo-faq"><summary>' + esc(faq.q) + "</summary><p>" + esc(faq.a) + "</p></details>"
      ).join("\n"),
      "  </div>"
    ].join("\n"));
  }

  const related = (tool.relatedSlugs || [])
    .map((slug) => TOOL_BY_SLUG.get(slug))
    .filter((item) => item && INDEXABLE_TOOLS.includes(item) && item.slug !== tool.slug);
  if (related.length) {
    blocks.push([
      '  <div class="tool-seo-block">',
      "    <h2>Related tools</h2>",
      '    <div class="tool-seo-related">' + related.map((item) =>
        '\n      <a href="' + esc(routeFor(item)) + '">' + esc(item.name) + "</a>"
      ).join("") + "\n    </div>",
      "  </div>"
    ].join("\n"));
  }

  return blocks.length ? '\n<section class="tool-seo-content">\n' + blocks.join("\n\n") + "\n</section>\n\n" : "";
}

function toolSchemas(tool) {
  const canonical = canonicalFor(tool);
  const blocks = [
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: tool.name,
      url: canonical,
      description: tool.description,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript and a modern web browser",
      isAccessibleForFree: true,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.domain.replace(/\/$/, "") + "/" },
        { "@type": "ListItem", position: 2, name: tool.name, item: canonical }
      ]
    }
  ];
  if (tool.faqs?.length) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: tool.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.q,
        acceptedAnswer: { "@type": "Answer", text: faq.a }
      }))
    });
  }
  // Phase 12: only emitted when tool.landing.howItWorks genuinely exists,
  // because renderSeoSection() below only renders a "How it works" section
  // (the .tool-seo-step blocks) when that same data is present - this
  // schema must never describe steps the visible page doesn't actually
  // show, so it reuses that exact data rather than a separate copy.
  if (tool.landing?.howItWorks?.length) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "How to use " + tool.name,
      step: tool.landing.howItWorks.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: step.title,
        text: step.desc
      }))
    });
  }
  return blocks.map(jsonLd).join("");
}

function renderTool(tool) {
  const canonical = canonicalFor(tool);
  const h1 = tool.h1 || tool.name;
  const valueProp = tool.landing?.hero?.valueProp || tool.description;
  let out = HOMEPAGE;

  out = replaceRequired(out, /<title>[^<]*<\/title>/, "<title>" + esc(tool.title) + "</title>", tool.slug + " title");
  out = replaceRequired(out, /<meta name="description" content="[^"]*">/, '<meta name="description" content="' + esc(tool.description) + '">', tool.slug + " description");
  out = replaceRequired(out, /<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="' + esc(canonical) + '">', tool.slug + " canonical");
  out = replaceRequired(out, /<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + esc(canonical) + '">', tool.slug + " og:url");
  out = replaceRequired(out, /<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + esc(tool.title) + '">', tool.slug + " og:title");
  out = replaceRequired(out, /<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + esc(tool.description) + '">', tool.slug + " og:description");
  out = replaceRequired(out, /<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + esc(tool.title) + '">', tool.slug + " twitter:title");
  out = replaceRequired(out, /<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + esc(tool.description) + '">', tool.slug + " twitter:description");
  out = replaceRequired(out, /<h1><span class="hero-line1"[^>]*>[\s\S]*?<\/h1>/, "<h1>" + esc(h1) + "</h1>", tool.slug + " h1");
  out = replaceRequired(out, /<p class="tagline"[^>]*>[\s\S]*?<\/p>/, '<p class="tagline">' + esc(valueProp) + "</p>", tool.slug + " tagline");

  out = replaceRequired(out, SOFTWAREAPP_JSONLD_RE, "<!-- TOOL_SCHEMA_INSERT -->\n", tool.slug + " homepage schema removal");
  out = replaceRequired(out, FAQPAGE_JSONLD_RE, "", tool.slug + " homepage FAQ schema removal");
  out = replaceRequired(out, "<!-- TOOL_SCHEMA_INSERT -->\n", toolSchemas(tool), tool.slug + " tool schema");
  // Inserted before </main>, not before <footer>: the homepage template's
  // </main> sits directly above <footer> with nothing but whitespace
  // between them, so this content previously landed outside every
  // landmark - failing axe's "region" rule (every tool-seo-block and its
  // FAQ heading were unreachable via landmark navigation). It genuinely
  // is main content, so keeping it inside <main> is also the more
  // accurate landmark, not just an axe workaround.
  out = replaceRequired(out, "</main>", renderSeoSection(tool) + "</main>", tool.slug + " SEO section");
  out = renderRuntime(out, runtimeForTool(tool.toolId), tool.slug);
  return out;
}

function renderRuntimeRouting() {
  const routes = {};
  for (const tool of GENERATED_TOOLS) {
    routes[tool.toolId] = {
      path: routeFor(tool),
      title: tool.title,
      description: tool.description
    };
  }
  const block = [
    "/* SEO_TOOL_ROUTES_START */",
    "const TOOL_ROUTES = " + JSON.stringify(routes) + ";",
    "/* SEO_TOOL_ROUTES_END */"
  ].join("\n");
  return replaceRequired(ROUTING_TEMPLATE, TOOL_ROUTES_RE, block, "runtime tool routes");
}

function renderSitemap() {
  const urls = [site.domain.replace(/\/$/, "") + "/"]
    .concat(INDEXABLE_TOOLS.map(canonicalFor))
    .concat(staticPages.map(staticCanonicalFor));
  // lastmod comes from site.lastmod in seo/tools-registry.json, NOT the
  // current date. This used to be `new Date()` at generation time, which
  // made `npm run seo:check` (a byte-for-byte comparison against the
  // committed sitemap.xml) fail every calendar day after the sitemap was
  // last regenerated - including on Netlify, where it broke the deploy.
  // Every URL still shares one value rather than claiming a per-page edit
  // history the registry has no real record of.
  // MAINTAINERS: bump site.lastmod to the date of the change whenever SEO
  // content (registry copy, tool pages, routes) changes, then run
  // `npm run generate` and commit the regenerated files. Forgetting to
  // bump leaves an older date but never breaks the build; the value is
  // validated for format/real-calendar-date in validateRegistry().
  const lastmod = site.lastmod;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.map((url) => "  <url><loc>" + esc(url) + "</loc><lastmod>" + lastmod + "</lastmod></url>").join("\n"),
    "</urlset>",
    ""
  ].join("\n");
}

function renderRobots() {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    "Sitemap: " + site.domain.replace(/\/$/, "") + "/sitemap.xml",
    ""
  ].join("\n");
}

function renderRedirects() {
  return [
    "# Generated from the Phase 9 tool registries. Do not edit route rules by hand.",
    "# Explicit rewrites keep every clean URL stable on any Netlify configuration.",
    ...INDEXABLE_TOOLS.map((tool) => routeFor(tool) + "  /" + tool.file + "  200"),
    ...staticPages.map((page) => staticRouteFor(page) + "  /" + page.file + "  200"),
    "",
    "# Unknown routes must return a real 404 instead of a soft-200 copy of the homepage.",
    "/*  /404.html  404",
    ""
  ].join("\n");
}

const outputs = new Map([
  ["index.html", HOMEPAGE],
  ["sitemap.xml", renderSitemap()],
  ["robots.txt", renderRobots()],
  ["_redirects", renderRedirects()],
  ["js/core/routing.js", renderRuntimeRouting()]
]);
for (const tool of GENERATED_TOOLS) outputs.set(tool.file, renderTool(tool));

const drift = [];
for (const [relativePath, content] of outputs) {
  const absolutePath = path.join(ROOT, relativePath);
  if (CHECK_ONLY) {
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : null;
    if (current !== content) drift.push(relativePath);
  } else {
    fs.writeFileSync(absolutePath, content);
    console.log("Generated: " + relativePath);
  }
}

if (CHECK_ONLY && drift.length) {
  console.error("SEO output is out of date: " + drift.join(", "));
  console.error("Run: npm run generate");
  process.exitCode = 1;
} else if (CHECK_ONLY) {
  console.log("SEO output is current (" + outputs.size + " files checked).");
} else {
  console.log("\nDone. Generated " + outputs.size + " SEO-managed files.");
}
