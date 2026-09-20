import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  externalScriptTags,
  findUnprotectedThirdPartyScripts,
  isApprovedGoogleManagedScript,
  AD_ENABLED_FILES,
} from "./helpers/third-party-scripts.js";

// Google AdSense foundation: privacy copy + crawlable privacy page, ads.txt, the sitewide
// loader (homepage + every tool page, never privacy/404) and the strict-CSP wiring.
// There are deliberately NO ad units, containers, Auto Ads or fake slot IDs yet (no real
// ad unit exists) - several tests below pin that scope so it cannot grow by accident.
// The nonce Edge Function itself is covered by tests/csp-nonce-edge.test.js.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const adsense = require("../build/adsense-config.js");
const registry = JSON.parse(readFileSync(resolve(ROOT, "seo/tools-registry.json"), "utf8"));
const additional = JSON.parse(readFileSync(resolve(ROOT, "seo/additional-tools.json"), "utf8"));
const staticPages = JSON.parse(readFileSync(resolve(ROOT, "seo/static-pages.json"), "utf8")).pages;
const tools = [...registry.tools, ...additional.tools].filter((tool) => tool.status !== "planned");
const site = registry.site;
const read = (file) => readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const AD_MARKERS = /adsbygoogle|googlesyndication|doubleclick|ca-pub-|ADSENSE_LOADER/i;

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------ ads.txt
describe("ads.txt", () => {
  it("A. exists at the repository root", () => {
    expect(existsSync(resolve(ROOT, "ads.txt"))).toBe(true);
  });

  it("B. contains exactly the one Google AdSense DIRECT record for our publisher id, and nothing else", () => {
    const records = read("ads.txt").split("\n").map((line) => line.trim()).filter(Boolean);
    expect(records).toEqual(["google.com, pub-6665490745490381, DIRECT, f08c47fec0942fa0"]);
    expect(records[0]).toBe(adsense.ADS_TXT_LINE);
    expect(records[0]).toMatch(/^google\.com, pub-\d{16}, DIRECT, f08c47fec0942fa0$/);
    expect(read("ads.txt")).not.toContain("#"); // no comments, no other networks
  });

  it("G. uses the same publisher id as the AdSense loader (ads.txt drops the ca- prefix)", () => {
    expect(adsense.PUBLISHER_ID).toBe("ca-pub-6665490745490381");
    expect(adsense.ADSENSE_SCRIPT_SRC).toBe("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6665490745490381");
    expect(adsense.ADS_TXT_LINE).toContain(adsense.PUBLISHER_ID.replace(/^ca-/, ""));
  });

  it("C. is wired into the build so it reaches dist/ (Vite copy list + verify-dist)", () => {
    const vite = read("vite.config.js");
    expect(vite).toMatch(/deploymentFiles\s*=\s*\[[^\]]*"ads\.txt"[^\]]*\]/);
    const verify = read("build/verify-dist.js");
    expect(verify).toMatch(/copiedRootFiles\s*=\s*\[[^\]]*"ads\.txt"[^\]]*\]/);
    expect(verify).toContain("dist/ads.txt must contain exactly");
  });

  it.skipIf(!existsSync(resolve(ROOT, "dist", "ads.txt")))("C. dist/ads.txt (when a build exists) is byte-identical to the source", () => {
    expect(readFileSync(resolve(ROOT, "dist", "ads.txt")).equals(readFileSync(resolve(ROOT, "ads.txt")))).toBe(true);
  });
});

// ------------------------------------------------------------ loader placement
describe("AdSense loader placement (homepage + every tool page; never privacy/404)", () => {
  const adFiles = ["index.html", ...tools.map((tool) => tool.file)];

  it("D. every AdSense-enabled page contains the Google-supplied tag exactly once, async and cross-origin", () => {
    expect(adFiles.length).toBe(36);
    for (const file of adFiles) {
      const html = read(file);
      expect((html.match(/adsbygoogle\.js/g) || []).length, file).toBe(1);
      expect((html.match(/adsbygoogle/g) || []).length, file).toBe(1);
      expect(html, file).toContain(adsense.ADSENSE_SCRIPT_TAG);
      expect(html, file).toContain("ca-pub-6665490745490381");
      const tags = externalScriptTags(html).filter((tag) => tag.src === adsense.ADSENSE_SCRIPT_SRC);
      expect(tags, file).toHaveLength(1);
      expect(tags[0].attributes, file).toMatch(/\basync\b/);
      expect(tags[0].attributes, file).toContain('crossorigin="anonymous"');
      expect(tags[0].attributes, file).not.toMatch(/\bintegrity=/);
      expect(isApprovedGoogleManagedScript(file, tags[0]), file).toBe(true);
    }
  });

  it("D. the tag lives in <head>, between its own markers, and outside the generated runtime-library block", () => {
    for (const file of adFiles) {
      const html = read(file);
      const start = html.indexOf("<!-- ADSENSE_LOADER_START -->");
      const end = html.indexOf("<!-- ADSENSE_LOADER_END -->");
      const tag = html.indexOf(adsense.ADSENSE_SCRIPT_TAG);
      expect(start, file).toBeGreaterThan(-1);
      expect(tag, file).toBeGreaterThan(start);
      expect(end, file).toBeGreaterThan(tag);
      expect(end, file).toBeLessThan(html.indexOf("</head>"));
      expect(html.split("<!-- ADSENSE_LOADER_START -->").length - 1, file).toBe(1);
      expect(html.split("<!-- ADSENSE_LOADER_END -->").length - 1, file).toBe(1);
      const libStart = html.indexOf("<!-- RUNTIME_LIBRARIES_START -->");
      const libEnd = html.indexOf("<!-- RUNTIME_LIBRARIES_END -->");
      expect(tag < libStart || tag > libEnd, file).toBe(true);
    }
  });

  it("F. 404.html and every static page (privacy) do not load AdSense", () => {
    expect(read("404.html")).not.toMatch(AD_MARKERS);
    for (const page of staticPages) expect(read(page.file), page.file).not.toMatch(AD_MARKERS);
  });

  it("the set of HTML files that carry the loader is exactly the AdSense-enabled set", () => {
    const withLoader = readdirSync(ROOT).filter((file) => file.endsWith(".html") && /adsbygoogle\.js/.test(read(file))).sort();
    expect(withLoader).toEqual([...adFiles].sort());
    expect(AD_ENABLED_FILES.slice().sort()).toEqual([...adFiles].sort());
  });

  it("L. no ad units/containers, push() call, Auto Ads code, or fake slot id exist anywhere (no real ad-slot ID yet)", () => {
    for (const file of readdirSync(ROOT).filter((name) => name.endsWith(".html"))) {
      expect(read(file), file).not.toMatch(/adsbygoogle\s*=|adsbygoogle\.push|\(adsbygoogle|<ins\b[^>]*adsbygoogle|data-ad-client|data-ad-slot|enable_page_level_ads|google_ad_client/);
    }
    for (const file of walkFiles(resolve(ROOT, "js")).concat(walkFiles(resolve(ROOT, "css")))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/adsbygoogle|googlesyndication|pagead2/i);
    }
  });

  it("no page has an inline executable <script> (it would need a nonce and would defeat the strict CSP)", () => {
    for (const file of readdirSync(ROOT).filter((name) => name.endsWith(".html"))) {
      const html = read(file).replace(/<!--[\s\S]*?-->/g, "");
      expect(html, file).not.toMatch(/<script\b(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i);
    }
  });

  it("the generator emits the loader for the homepage and inherits it into every tool page (no stripping)", () => {
    const generator = read("build/generate-landing.js");
    expect(generator).toContain("ADSENSE_LOADER_START");
    expect(generator).not.toContain("AdSense block removal");
    expect(generator).not.toContain("ADSENSE_BLOCK_LINE_RE");
    expect(generator).toContain('require("./adsense-config.js")');
  });
});

// --------------------------------------------------------- SRI rule remains
describe("SRI rule stays enforced (H)", () => {
  const cdnjs = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js';
  const page = (tags) => "<html><head>" + tags.join("\n") + "</head></html>";

  it("every real generated page passes the rule, with the AdSense exception used only by AdSense-enabled pages", () => {
    for (const file of AD_ENABLED_FILES) expect(findUnprotectedThirdPartyScripts(file, read(file)), file).toEqual([]);
    const used = AD_ENABLED_FILES.filter((file) => externalScriptTags(read(file)).some((tag) => isApprovedGoogleManagedScript(file, tag)));
    expect(used).toEqual(AD_ENABLED_FILES);
  });

  it("the approved loader on the homepage and on a tool page is accepted", () => {
    expect(findUnprotectedThirdPartyScripts("index.html", page([adsense.ADSENSE_SCRIPT_TAG]))).toEqual([]);
    expect(findUnprotectedThirdPartyScripts("merge-pdf.html", page([adsense.ADSENSE_SCRIPT_TAG]))).toEqual([]);
  });

  it("the SAME loader on privacy/404 (or any unknown page) is rejected", () => {
    for (const file of ["privacy-policy.html", "404.html", "unknown.html"]) {
      expect(findUnprotectedThirdPartyScripts(file, page([adsense.ADSENSE_SCRIPT_TAG]))).not.toEqual([]);
    }
  });

  it("other Google URLs, another publisher id, or missing attributes are rejected even on an enabled page", () => {
    const bad = [
      '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1111111111111111" crossorigin="anonymous"></script>',
      '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX" crossorigin="anonymous"></script>',
      '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6665490745490381"></script>',
      '<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6665490745490381" crossorigin="anonymous"></script>',
    ];
    for (const tag of bad) expect(findUnprotectedThirdPartyScripts("merge-pdf.html", page([tag])), tag).not.toEqual([]);
  });

  it("unrelated third-party scripts are still rejected without SRI, on enabled pages too", () => {
    const noSri = `<script defer src="${cdnjs}" crossorigin="anonymous"></script>`;
    const evil = '<script async src="https://example.com/track.js" crossorigin="anonymous"></script>';
    expect(findUnprotectedThirdPartyScripts("index.html", page([noSri, adsense.ADSENSE_SCRIPT_TAG]))).toEqual([`index.html: ${cdnjs} has no SRI`]);
    expect(findUnprotectedThirdPartyScripts("merge-pdf.html", page([evil, adsense.ADSENSE_SCRIPT_TAG]))).toHaveLength(1);
    expect(findUnprotectedThirdPartyScripts("privacy-policy.html", page([noSri]))).toHaveLength(1);
  });

  it("a properly pinned library is still accepted", () => {
    const ok = `<script defer src="${cdnjs}" integrity="sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt" crossorigin="anonymous"></script>`;
    expect(findUnprotectedThirdPartyScripts("index.html", page([ok, adsense.ADSENSE_SCRIPT_TAG]))).toEqual([]);
  });
});

// --------------------------------------------------------------------- CSP
describe("CSP: the strict static policy is unchanged; the loader is never allowed statically", () => {
  const STRICT_CSP =
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' data: blob: https://cdnjs.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests";
  const headersText = read("_headers");
  const rules = headersText.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#") && !/^\s/.test(line));
  const values = Object.fromEntries(headersText.split("\n").filter((line) => /^\s+[A-Za-z-]+:/.test(line)).map((line) => { const at = line.indexOf(":"); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));

  it("the strict Content-Security-Policy on /* is byte-for-byte unchanged", () => {
    expect(values["Content-Security-Policy"]).toBe(STRICT_CSP);
  });

  it("_headers has exactly one path rule (/*): there is no homepage or per-page CSP override", () => {
    expect(rules).toEqual(["/*"]);
  });

  it("no Google ad host, Report-Only trial, COEP or unsafe-* appears in the static headers", () => {
    expect(headersText.replace(/^#.*$/gm, "")).not.toMatch(/googlesyndication|doubleclick|adtrafficquality|googleads|Report-Only|Cross-Origin-Embedder-Policy/i);
    expect(values["Content-Security-Policy"]).not.toMatch(/script-src[^;]*'unsafe-/);
    expect(values["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });

  it("COOP, CORP, X-Frame-Options, frame-ancestors, worker-src and the other security headers are present", () => {
    expect(values["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(values["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(values["X-Frame-Options"]).toBe("DENY");
    expect(values["X-Content-Type-Options"]).toBe("nosniff");
    expect(values["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(values["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(values["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(values["Content-Security-Policy"]).toContain("worker-src 'self' blob:");
  });

  it("the nonce Edge Function exists and is the only place the AdSense-enabled pages get a script policy that can run the loader", () => {
    expect(existsSync(resolve(ROOT, "netlify/edge-functions/csp-nonce.js"))).toBe(true);
  });
});

describe("crawlable Privacy Policy page", () => {
  const entry = staticPages.find((page) => page.slug === "privacy-policy");
  const html = read("privacy-policy.html");
  const canonical = site.domain.replace(/\/$/, "") + "/privacy-policy";

  it("is registered, canonical, indexable, and has its own unique title and description", () => {
    expect(entry).toBeTruthy();
    expect(entry.file).toBe("privacy-policy.html");
    expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(html).not.toMatch(/noindex/i);
    expect(html).toContain(`<title>${entry.title}</title>`);
    expect(html).toContain(`<meta name="description" content="${entry.description}">`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}">`);
    for (const tool of tools) {
      expect(tool.title).not.toBe(entry.title);
      expect(tool.description).not.toBe(entry.description);
    }
  });

  it("is in the sitemap and has a clean-URL rewrite", () => {
    expect(read("sitemap.xml")).toContain(`<loc>${canonical}</loc>`);
    expect(read("_redirects")).toContain("/privacy-policy  /privacy-policy.html  200");
    expect(read("_redirects").trimEnd().endsWith("/*  /404.html  404")).toBe(true);
  });

  it("is linked from the footer of the homepage and every tool page, replacing the modal-only button", () => {
    for (const file of ["index.html", ...tools.map((tool) => tool.file)]) {
      const page = read(file);
      expect((page.match(/<a href="\/privacy-policy" data-i18n="footer\.privacy">Privacy<\/a>/g) || []).length, file).toBe(1);
      expect(page, file).not.toContain('data-open="privacy"');
    }
  });

  it("is accessible, responsive and self-contained: lang, viewport, one h1, skip link, landmarks, resolving anchors, alt text", () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect((html.match(/<h1[\s>]/g) || []).length).toBe(1);
    expect(html).toContain('class="skip-link"');
    expect(html).toContain("<main");
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(target), "#" + target).toBe(true);
    for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) expect(tag).toMatch(/\balt="/);
    // no scripts other than the local pre-paint theme script; no inline handlers
    const markup = html.replace(/<!--[\s\S]*?-->/g, ""); // ignore explanatory HTML comments
    expect([...markup.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="js/core/pretheme.js">']);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    // external links open safely
    for (const [tag] of html.matchAll(/<a\b[^>]*href="https?:\/\/[^"]+"[^>]*>/g)) expect(tag).toContain('rel="noopener noreferrer"');
  });

  it("describes browser-side file processing, browser storage, ratings, advertising / Google AdSense, choices and the existing contact route", () => {
    for (const phrase of [
      "not uploaded to, stored on, or sent to YOYOPDF's servers",
      "local storage",
      "does not set cookies of its own",
      "Star ratings",
      "Google AdSense",
      "third-party vendor",
      "cookies or similar technologies",
      "does not send your files to advertisers",
      "third-party code loaded from Google",
      "homepage and on eligible tool pages",
      "does not upload them to its own servers for processing",
      "Google Ad Settings",
      "https://adssettings.google.com",
      "https://policies.google.com/technologies/partner-sites",
      "block or delete cookies",
      "Contact</strong> option",
    ]) expect(html, phrase).toContain(phrase);
  });

  it("makes no absolute no-tracking/no-cookies claim and no legal-compliance claim", () => {
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/no tracking|no analytics|no cookies|cookie-free|100% private|we never track/i);
    expect(text).not.toMatch(/\b(gdpr|ccpa|dpdp|compliant|compliance|legally)\b/i);
  });

  it("does not load AdSense itself, and no longer says ads load only on the homepage", () => {
    expect(html).not.toMatch(AD_MARKERS);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).not.toMatch(/loaded only on the YOYOPDF homepage|only on the (YOYOPDF )?homepage|not in the tool workspaces/i);
    expect(text).not.toMatch(/can never|cannot ever|never access|no third.party (script|code) can/i);
  });
});

describe("privacy/trust copy in every language", () => {
  const src = readFileSync(resolve(ROOT, "js/core/i18n.js"), "utf8");
  const stub = { getItem() { return null; }, setItem() {} };
  const sandbox = {
    console, setTimeout, localStorage: stub, navigator: { language: "en" },
    document: { documentElement: { setAttribute() {}, getAttribute() { return null; }, lang: "" }, addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; }, createElement() { return {}; } },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch { /* the script's DOM bootstrap may throw after I18N is defined */ }
  const T = sandbox.I18N?.translations;
  const langs = ["en", "hi", "es", "fr", "de", "pt", "ja", "zh", "ko", "ar"];

  it("loads all 10 language blocks", () => {
    expect(T && Object.keys(T)).toEqual(langs);
  });

  it("every language has the new Advertising strings and the link to the full page, non-empty", () => {
    for (const lang of langs) {
      for (const key of ["privacy.navAdvertising", "privacy.sectionAdvertising", "privacy.advertisingBody", "privacy.fullPage"]) {
        expect(T[lang][key], lang + " " + key).toBeTruthy();
      }
      expect(T[lang]["privacy.advertisingBody"], lang).toMatch(/Google/);
      expect(T[lang]["privacy.advertisingBody"], lang).toMatch(/AdSense/);
      expect(T[lang]["privacy.cookiesBody"], lang).toMatch(/Google/);
      expect(T[lang]["privacy.overviewBody"], lang).toMatch(/AdSense/);
    }
  });

  it("the absolute tracking/cookies/servers claims are gone (English) and the replacements are consistent across languages", () => {
    const en = T.en;
    const joined = Object.values(en).join("\n");
    expect(joined).not.toMatch(/No analytics, cookies|We don't use tracking cookies|No uploads\. No tracking|No servers|No Data Selling|100% Private by Default|share anything/);
    expect(en["home.supportP2"]).toBe("No file uploads. Your files stay in your browser.");
    for (const lang of langs) {
      expect(T[lang]["privacy.feature3Title"], lang).toBe(T[lang]["privacy.principle3"]);
      // still says files are not uploaded (browser-side processing is unchanged)
      expect(T[lang]["privacy.overviewBody"], lang).toBeTruthy();
      // no language keeps the old 'No Tracking' / 'No Data Selling' labels
      expect(T[lang]["privacy.nodeNoTracking"], lang).not.toBe(T[lang]["privacy.feature3Desc"]);
    }
    expect(en["privacy.overviewBody"]).toContain("nothing is uploaded, stored, or transmitted to any server");
    expect(en["privacy.cookiesBody"]).toContain("does not set cookies of its own");
  });

  it("the in-app Privacy panel renders the Advertising section and links to the crawlable page", () => {
    const misc = read("js/tools/misc-tools.js");
    expect(misc).toContain('href="#privacy-advertising"');
    expect(misc).toContain('id="privacy-advertising"');
    expect(misc).toContain('privacy.advertisingBody');
    expect(misc).toContain('href="/privacy-policy"');
  });
});

// ---------------------------------------------------- generator / registry
describe("static-page registry and sitemap wiring", () => {
  it("static pages have valid, non-colliding metadata", () => {
    const routes = new Set(tools.map((tool) => "/" + tool.file.replace(/\.html$/, "")));
    for (const page of staticPages) {
      expect(page.file).toMatch(/^[a-z0-9-]+\.html$/);
      expect(routes.has("/" + page.file.replace(/\.html$/, ""))).toBe(false);
      expect(existsSync(resolve(ROOT, page.file))).toBe(true);
    }
  });

  it("the sitemap lastmod was bumped for this inventory change and is still a fixed registry date (not generated from today)", () => {
    expect(site.lastmod >= "2026-09-20").toBe(true); // this change adds an indexable page
    const generator = read("build/generate-landing.js");
    expect(generator).not.toMatch(/new Date\(\)\s*\.toISOString/);
  });
});
