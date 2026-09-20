const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "seo", "tools-registry.json"), "utf8"));
const additional = JSON.parse(fs.readFileSync(path.join(ROOT, "seo", "additional-tools.json"), "utf8"));
const { homepageRuntime, runtimeForTool } = require("./runtime-manifest.js");
const adsense = require("./adsense-config.js");
const staticPages = JSON.parse(fs.readFileSync(path.join(ROOT, "seo", "static-pages.json"), "utf8")).pages;
const tools = [...registry.tools, ...additional.tools]
  .filter((tool) => tool.status !== "planned");
const toolsByFile = new Map(tools.map((tool) => [tool.file, tool]));

const appPages = ["index.html", ...tools.map((tool) => tool.file)];
const expectedHtmlPages = [...appPages, ...staticPages.map((page) => page.file), "404.html"];
const knownRoutes = new Set([
  "/",
  ...tools.map((tool) => "/" + tool.file.replace(/\.html$/, "")),
  ...staticPages.map((page) => "/" + page.file.replace(/\.html$/, ""))
]);
const staticDirectories = ["js", "css", "assets"];
const copiedRootFiles = ["_headers", "_redirects", "robots.txt", "sitemap.xml", "ads.txt"];
const sriHashes = [
  "sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI",
  "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  "sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt",
  "sha384-Z3REaz79l2IaAZqJsSABtTbhjgOUYyV3p90XNnAPCSHg3EMTz1fouunq9WZRtj3d",
  "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG",
  "sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz",
  "sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw",
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function expectFile(relativePath, reason) {
  const absolutePath = path.join(DIST, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail((reason || "Missing build file") + ": " + relativePath);
  }
}

function walkFiles(directory, relativeBase = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeBase, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function stripQueryAndHash(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
}

function scriptTags(html) {
  const tags = [];
  const pattern = /<script\s+([^>]*\bsrc="([^"]+)"[^>]*)><\/script>/g;
  let match;
  while ((match = pattern.exec(html))) tags.push({ attributes: match[1], src: match[2] });
  return tags;
}
function verifyHtmlReferences(relativePage) {
  const html = fs.readFileSync(path.join(DIST, relativePage), "utf8");
  const referencePattern = /\b(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = referencePattern.exec(html))) {
    const rawReference = match[1];
    if (isExternalReference(rawReference)) continue;
    const reference = stripQueryAndHash(rawReference);
    if (!reference || knownRoutes.has(reference)) continue;

    const target = reference.startsWith("/")
      ? path.join(DIST, reference.slice(1))
      : path.resolve(path.dirname(path.join(DIST, relativePage)), reference);
    const relativeTarget = path.relative(DIST, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      fail(relativePage + " references a path outside dist: " + rawReference);
    } else if (!fs.existsSync(target)) {
      fail(relativePage + " has an unresolved local reference: " + rawReference);
    }
  }
}

if (!fs.existsSync(DIST)) {
  console.error("dist does not exist. Run vite build before verify:dist.");
  process.exit(1);
}

for (const page of expectedHtmlPages) expectFile(page, "Missing HTML entry");
for (const file of copiedRootFiles) {
  expectFile(file, "Missing deployment control file");
  const source = fs.readFileSync(path.join(ROOT, file));
  const built = fs.existsSync(path.join(DIST, file)) ? fs.readFileSync(path.join(DIST, file)) : null;
  if (built && !source.equals(built)) fail("Build copy drifted from source: " + file);
}

// ads.txt: exactly one record (the Google AdSense DIRECT line for our
// publisher id) and no other seller/network.
{
  const adsTxtPath = path.join(DIST, "ads.txt");
  if (fs.existsSync(adsTxtPath)) {
    const records = fs.readFileSync(adsTxtPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (records.length !== 1 || records[0] !== adsense.ADS_TXT_LINE) {
      fail("dist/ads.txt must contain exactly: " + adsense.ADS_TXT_LINE);
    }
  }
}

// css/site.css (Phase 12) is intentionally NOT expected as a raw dist/css/
// copy — vite.config.js's copyClassicRuntime() skips it on purpose because
// it's the one css/ file Vite's own HTML processing already fingerprints/
// minifies into dist/assets/ (every page's real <link> tag points there,
// verified separately below). Every other css/*.css file (editor
// stylesheets, only ever loaded via a literal runtime string path Vite's
// static scan can't see) still needs, and gets, the raw copy.
const RAW_COPY_EXCEPTIONS = new Set([path.join("css", "site.css")]);

let copiedRuntimeFileCount = 0;
for (const directory of staticDirectories) {
  for (const relativeFile of walkFiles(path.join(ROOT, directory))) {
    const relativePath = path.join(directory, relativeFile);
    if (RAW_COPY_EXCEPTIONS.has(relativePath)) continue;
    copiedRuntimeFileCount += 1;
    expectFile(relativePath, "Missing copied runtime asset");
  }
}

// The hashed replacement for css/site.css: exactly one file, shared
// identically by every page's <link> tag — not one copy per page, and not
// silently dropped instead of skipped.
const hashedSiteCss = fs.existsSync(path.join(DIST, "assets"))
  ? fs.readdirSync(path.join(DIST, "assets")).filter((name) => /^site-.*\.css$/.test(name))
  : [];
if (hashedSiteCss.length !== 1) {
  fail(`Expected exactly one hashed dist/assets/site-*.css, found ${hashedSiteCss.length}`);
} else {
  const hashedHref = "/assets/" + hashedSiteCss[0];
  // appPages only: 404.html is a genuinely separate, standalone error page
  // (Phase 10) with its own small self-contained <style> block — it was
  // never part of the shared homepage/tool-page style block this
  // extraction moved out, so it correctly keeps neither the link nor the
  // "no inline <style>" expectation the templated pages now have.
  for (const page of appPages) {
    const html = fs.readFileSync(path.join(DIST, page), "utf8");
    if (!html.includes(`href="${hashedHref}"`)) {
      fail(`${page} does not link the shared hashed stylesheet ${hashedHref}`);
    }
    if (html.includes("<style>")) {
      fail(`${page} still has an inline <style> block instead of only the external stylesheet`);
    }
  }
}

for (const page of expectedHtmlPages) verifyHtmlReferences(page);

// Phase 13: pretheme.js/prelanguage.js/tool-preload.js/lazy-loaders.js are
// synchronous, unversioned, always-present pre-paint scripts moved out of
// index.html's inline <script> blocks - production's CSP (_headers)
// script-src has no 'unsafe-inline'/nonce/hash, which silently blocked
// those as inline blocks (data-theme never set before first paint, and
// loadScriptOnce/ensurePDFLib/etc. never defined at all). They're plain
// <script src> tags on every page but are NOT part of the versioned,
// per-tool RUNTIME_LIBRARIES/RUNTIME_SCRIPTS profile runtime-manifest.js
// governs, so they're checked directly here instead of via that profile.
const PREPAINT_SCRIPTS = ["js/core/pretheme.js", "js/core/prelanguage.js", "js/core/tool-preload.js"];
const LAZY_LOADER_SCRIPT = "js/core/lazy-loaders.js";
const lazyLoaderSource = fs.existsSync(path.join(DIST, LAZY_LOADER_SCRIPT))
  ? fs.readFileSync(path.join(DIST, LAZY_LOADER_SCRIPT), "utf8")
  : null;
if (!lazyLoaderSource) fail("Missing " + LAZY_LOADER_SCRIPT + " in dist");
else if (!/s\.integrity\s*=\s*integrity/.test(lazyLoaderSource) || !/s\.crossOrigin\s*=\s*["']anonymous["']/.test(lazyLoaderSource)) {
  fail(LAZY_LOADER_SCRIPT + " does not preserve SRI/crossOrigin assignment for lazy Phase 8 CDN scripts");
}

for (const page of appPages) {
  const html = fs.readFileSync(path.join(DIST, page), "utf8");
  const runtime = page === "index.html"
    ? homepageRuntime()
    : runtimeForTool(toolsByFile.get(page).toolId);
  const tags = scriptTags(html);
  const localScripts = tags.filter((tag) => !/^https?:\/\//.test(tag.src)).map((tag) => tag.src);
  // AdSense exception (narrow and explicit): the Google-managed loader is the ONLY
  // external script allowed without SRI, only on the AdSense-enabled pages (the homepage and
  // every tool page, i.e. every page in appPages), and only as the exact approved URL. It
  // is separated out here so every other external script is still compared against, and held
  // to, the pinned runtime-library list with integrity hashes.
  const adsenseTags = tags.filter((tag) => tag.src === adsense.ADSENSE_SCRIPT_SRC);
  const externalScripts = tags.filter((tag) => /^https?:\/\//.test(tag.src) && tag.src !== adsense.ADSENSE_SCRIPT_SRC);
  if (adsenseTags.length !== 1) fail(page + " must contain the AdSense loader exactly once (found " + adsenseTags.length + ")");
  else if (!/\basync\b/.test(adsenseTags[0].attributes) || !adsenseTags[0].attributes.includes('crossorigin="anonymous"') || /\bintegrity=/.test(adsenseTags[0].attributes)) {
    fail(page + " AdSense loader must be async with crossorigin=anonymous and no integrity attribute");
  }
  if ((html.match(/adsbygoogle/g) || []).length !== 1) fail(page + " must reference adsbygoogle exactly once (no ad units/containers yet)");
  if (/adsbygoogle\s*=|adsbygoogle\.push|<ins\b[^>]*adsbygoogle|data-ad-client|data-ad-slot/.test(html)) {
    fail(page + " must not contain ad containers or an AdSense initialisation call (no real ad-slot ID exists)");
  }
  if (/doubleclick|googleadservices/i.test(html)) fail(page + " must not reference any other Google ad host");
  if (/<script\b(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i.test(html.replace(/<!--[\s\S]*?-->/g, ""))) {
    fail(page + " must not contain an inline executable <script> (it would need a nonce and defeat the strict CSP)");
  }

  for (const script of PREPAINT_SCRIPTS) {
    if (!localScripts.includes(script)) fail(page + " is missing the pre-paint script " + script);
  }
  if (!localScripts.includes(LAZY_LOADER_SCRIPT)) fail(page + " is missing " + LAZY_LOADER_SCRIPT);
  const runtimeManagedScripts = localScripts.filter(
    (src) => !PREPAINT_SCRIPTS.includes(src) && src !== LAZY_LOADER_SCRIPT
  );

  if (JSON.stringify(runtimeManagedScripts) !== JSON.stringify(runtime.scripts)) {
    fail(page + " does not match its generated local runtime profile");
  }
  if (JSON.stringify(externalScripts.map((tag) => tag.src)) !== JSON.stringify(runtime.libraries.map((library) => library.src))) {
    fail(page + " does not match its generated external runtime profile");
  }
  // Phase 13: these 7 pinned hashes must be reachable from every page
  // somehow, but not necessarily inline in THIS page's own HTML any more -
  // jszip/mammoth/xlsx (and the lazy pdf-lib/pdf.js fallbacks) live only in
  // the one shared lazy-loaders.js now, not duplicated per page. gsap/
  // ScrollTrigger's hash is still always inline (every profile loads them
  // eagerly), and non-image profiles still have pdf-lib/pdf.js inline too.
  for (const hash of sriHashes) {
    if (!html.includes(hash) && !(lazyLoaderSource && lazyLoaderSource.includes(hash))) {
      fail(page + " is missing Phase 8 SRI hash " + hash + " (checked page HTML and lazy-loaders.js)");
    }
  }
  for (const library of runtime.libraries) {
    const tag = externalScripts.find((candidate) => candidate.src === library.src);
    if (!tag || !tag.attributes.includes('integrity="' + library.integrity + '"')) {
      fail(page + " is missing the expected eager SRI attribute for " + library.src);
    }
    if (!tag || !tag.attributes.includes('crossorigin="anonymous"')) {
      fail(page + " is missing crossorigin=anonymous for " + library.src);
    }
  }
  if (!html.includes('<meta name="robots" content="index,follow,max-image-preview:large">')) {
    fail(page + " is missing the Phase 9 index directive");
  }
}

const headers = fs.readFileSync(path.join(DIST, "_headers"), "utf8");
for (const requiredPolicy of [
  "Content-Security-Policy:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "Referrer-Policy: strict-origin-when-cross-origin"
]) {
  if (!headers.includes(requiredPolicy)) fail("_headers is missing required policy: " + requiredPolicy);
}

// _headers + Edge Function structure for the sitewide AdSense nonce architecture.
// The enforced policy on /* is the STRICT policy and must stay exactly as it was (it is
// also what is served if the Edge Function fails or bypasses: fail closed). There must be
// no other path rule. The AdSense loader host is never allowed statically. The Edge
// Function's replacement policy must differ from the strict one ONLY in script-src (nonce
// + strict-dynamic) and base-uri 'none', must not widen frame-src/connect-src or add
// unsafe-*/wildcards/https:/http:, must re-set every security header with the same
// values, and must be scoped to exactly the AdSense-enabled routes (GET only, bypass on error).
{
  const blocks = [];
  let current = null;
  for (const raw of headers.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) { current = { path: raw.trim(), headers: {} }; blocks.push(current); }
    else if (current) {
      const at = raw.indexOf(":");
      current.headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
    }
  }
  const directives = (policy) => {
    const map = {};
    for (const part of (policy || "").split(";")) {
      const text = part.trim();
      if (text) map[text.split(/\s+/)[0]] = text;
    }
    return map;
  };
  const STRICT_SCRIPT_SRC = "script-src 'self' https://cdnjs.cloudflare.com";

  if (blocks.length !== 1 || blocks[0].path !== "/*") {
    fail("_headers must contain exactly one rule, /* (found: " + blocks.map((block) => block.path).join(", ") + ")");
  }
  const all = blocks.find((block) => block.path === "/*");
  const strict = all && all.headers["Content-Security-Policy"];
  if (!strict) fail("_headers must keep an enforced Content-Security-Policy on /*");
  else {
    const strictMap = directives(strict);
    if (strictMap["script-src"] !== STRICT_SCRIPT_SRC) fail("Enforced CSP script-src changed on /*: " + strictMap["script-src"]);
    if (/googlesyndication|doubleclick|adtrafficquality|googleadservices|googleads/.test(strict)) fail("The strict /* CSP must not allow Google ad hosts");
    if (!strict.includes("frame-ancestors 'none'")) fail("frame-ancestors 'none' must be preserved");
    if (/'unsafe-(inline|eval)'/.test(strictMap["script-src"] || "")) fail("script-src must not allow unsafe-inline/unsafe-eval");
    if (all.headers["Cross-Origin-Embedder-Policy"] !== undefined) fail("Cross-Origin-Embedder-Policy must not be set (it breaks ad resources)");
    if (all.headers["Cross-Origin-Opener-Policy"] !== "same-origin") fail("Cross-Origin-Opener-Policy: same-origin must be preserved");
    if (all.headers["X-Frame-Options"] !== "DENY") fail("X-Frame-Options: DENY must be preserved");

    // ---- the Edge Function, evaluated as a real ES module in a child process ----
    const edgeFile = path.join(ROOT, "netlify", "edge-functions", "csp-nonce.js");
    if (!fs.existsSync(edgeFile)) fail("netlify/edge-functions/csp-nonce.js is missing");
    else {
      let edge = null;
      try {
        const script = 'import(process.argv[1]).then((m)=>console.log(JSON.stringify({config:m.config,routes:m.AD_ROUTES,csp:m.buildCsp("NONCE"),security:m.SECURITY_HEADERS})))';
        edge = JSON.parse(require("child_process").execFileSync(process.execPath, ["-e", script, require("url").pathToFileURL(edgeFile).href], { encoding: "utf8" }));
      } catch (error) {
        fail("Could not evaluate netlify/edge-functions/csp-nonce.js: " + String(error.message).split("\n")[0]);
      }
      if (edge) {
        const expectedRoutes = ["/", ...tools.map((tool) => "/" + tool.file.replace(/\.html$/, ""))].sort();
        if (JSON.stringify([...edge.routes].sort()) !== JSON.stringify(expectedRoutes)) fail("Edge Function AD_ROUTES must equal the AdSense-enabled routes (homepage + every tool page)");
        const expectedPaths = ["/", ...tools.flatMap((tool) => { const r = "/" + tool.file.replace(/\.html$/, ""); return [r, r + ".html"]; })].sort();
        if (JSON.stringify([...edge.config.path].sort()) !== JSON.stringify(expectedPaths)) fail("Edge Function config.path must be exactly the AdSense-enabled routes and their .html files");
        if (edge.config.method !== "GET") fail("Edge Function must be GET only");
        if (edge.config.onError !== "bypass") fail("Edge Function must use onError: bypass (fail closed to the strict static policy)");
        for (const forbidden of ["/privacy-policy", "/404", "/api", "/js", "/css", "/assets", "/ads.txt", "/.netlify"]) {
          if (edge.config.path.some((route) => route === forbidden || route.startsWith(forbidden + "/") || route.startsWith(forbidden + "."))) fail("Edge Function must not match " + forbidden);
        }
        if (edge.config.path.some((route) => /[*(]/.test(route))) fail("Edge Function config.path must not use wildcards");

        const strictMap2 = directives(strict);
        const edgeMap = directives(edge.csp);
        for (const name of new Set([...Object.keys(strictMap2), ...Object.keys(edgeMap)])) {
          if (name === "script-src" || name === "base-uri") continue;
          if (strictMap2[name] !== edgeMap[name]) fail("Edge CSP directive '" + name + "' must equal _headers: " + edgeMap[name] + " vs " + strictMap2[name]);
        }
        if (edgeMap["script-src"] !== "script-src 'nonce-NONCE' 'strict-dynamic' 'self' https://cdnjs.cloudflare.com") fail("Edge CSP script-src is not the audited nonce policy: " + edgeMap["script-src"]);
        if (edgeMap["base-uri"] !== "base-uri 'none'") fail("Edge CSP must set base-uri 'none'");
        // script-src is what the nonce architecture is about; img-src https: and style-src 'unsafe-inline' are pre-existing and unchanged (compared above).
        if (/'unsafe-(inline|eval)'|(^|\s)\*(?=\s|$)|(^|\s)https?:(?=\s|$)/.test(edgeMap["script-src"])) fail("Edge CSP script-src must not use unsafe-inline/unsafe-eval, wildcards, or bare https:/http:");
        if (edge.csp.includes("'unsafe-eval'")) fail("Edge CSP must not use unsafe-eval anywhere");
        if (/googlesyndication|doubleclick|adtrafficquality|googleadservices|googleads/.test(edge.csp)) fail("Edge CSP must not list Google hosts (no allowlist; frame-src/connect-src are not widened)");
        if (edgeMap["frame-src"] || edgeMap["child-src"]) fail("Edge CSP must not add frame-src/child-src");
        for (const name of ["Referrer-Policy", "Permissions-Policy", "X-Content-Type-Options", "X-Frame-Options", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "X-XSS-Protection"]) {
          if (edge.security[name] !== all.headers[name]) fail("Edge Function security header " + name + " must equal _headers (" + all.headers[name] + ")");
        }
      }
    }
  }
}

if (fs.existsSync(path.join(DIST, "css", "landing.css"))) {
  fail("Unused legacy css/landing.css must not be copied to the production artifact");
}

const notFoundHtml = fs.readFileSync(path.join(DIST, "404.html"), "utf8");
if (!notFoundHtml.includes('<meta name="robots" content="noindex,follow">')) {
  fail("404.html must remain noindex,follow");
}

{
  const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
  for (const page of staticPages) {
    const html = fs.readFileSync(path.join(DIST, page.file), "utf8");
    const canonical = registry.site.domain.replace(/\/$/, "") + "/" + page.file.replace(/\.html$/, "");
    if (!html.includes('<link rel="canonical" href="' + canonical + '">')) fail(page.file + " has the wrong canonical URL");
    if (!html.includes('<meta name="robots" content="index,follow,max-image-preview:large">')) fail(page.file + " must be index,follow");
    if (!html.includes("<title>" + page.title + "</title>")) fail(page.file + " title does not match seo/static-pages.json");
    if (!sitemap.includes("<loc>" + canonical + "</loc>")) fail("sitemap.xml is missing " + canonical);
    if (/adsbygoogle|googlesyndication|doubleclick/i.test(html)) fail(page.file + " must not load Google AdSense");
  }
  if (/adsbygoogle|googlesyndication|doubleclick/i.test(notFoundHtml)) fail("404.html must not load Google AdSense");
}

const redirects = fs.readFileSync(path.join(DIST, "_redirects"), "utf8");
for (const tool of tools) {
  const route = "/" + tool.file.replace(/\.html$/, "");
  const expectedRule = route + "  /" + tool.file + "  200";
  if (!redirects.includes(expectedRule)) fail("_redirects is missing " + expectedRule);
}
for (const page of staticPages) {
  const route = "/" + page.file.replace(/\.html$/, "");
  const expectedRule = route + "  /" + page.file + "  200";
  if (!redirects.includes(expectedRule)) fail("_redirects is missing " + expectedRule);
}
if (!redirects.includes("/*  /404.html  404")) {
  fail("_redirects is missing the terminal 404 rule");
}

expectFile(path.join("js", "workers", "pdf-compress-worker.js"), "Compression worker missing from deploy artifact");
for (const editorFile of walkFiles(path.join(ROOT, "js", "editor"))) {
  expectFile(path.join("js", "editor", editorFile), "Lazy editor script missing from deploy artifact");
}
for (const editorCss of walkFiles(path.join(ROOT, "css")).filter((file) => file.startsWith("editor-") || file === "pdf-viewer.css")) {
  expectFile(path.join("css", editorCss), "Lazy editor stylesheet missing from deploy artifact");
}

if (failures.length) {
  console.error("Production artifact verification failed:");
  for (const message of [...new Set(failures)]) console.error("- " + message);
  process.exit(1);
}

console.log(
  "Production artifact verified: " +
  expectedHtmlPages.length + " HTML entries, " +
  tools.length + " clean tool routes, " +
  copiedRuntimeFileCount + " copied runtime files, and all Phase 8/9 invariants."
);
