import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import handler, { AD_ROUTES, SECURITY_HEADERS, addNonce, buildCsp, config, generateNonce } from "../netlify/edge-functions/csp-nonce.js";

// The Edge Function is HTML/security-header middleware ONLY. These tests pin: which routes it
// covers, that the nonce is a fresh 128-bit value that matches the header and every <script>,
// that everything else bypasses untouched, that existing security headers are preserved, that
// it fails closed, and - most importantly - that it never reads a request body and so can
// never see an uploaded file (PDF/image processing is entirely in the browser).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (file) => readFileSync(resolve(ROOT, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));
const tools = [...readJson("seo/tools-registry.json").tools, ...readJson("seo/additional-tools.json").tools].filter((tool) => tool.status !== "planned");
const toolRoutes = tools.map((tool) => "/" + tool.file.replace(/\.html$/, ""));
const headersText = readText("_headers").replace(/\r\n/g, "\n");
const staticHeaders = Object.fromEntries(
  headersText.split("\n").filter((line) => /^\s+[A-Za-z-]+:/.test(line)).map((line) => { const at = line.indexOf(":"); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; })
);

// A "request" that throws if anything tries to read its body: proves the handler never does.
function guardedRequest(url, method = "GET") {
  const request = new Request(url, { method });
  return new Proxy(request, {
    get(target, prop) {
      if (["body", "bodyUsed", "arrayBuffer", "blob", "formData", "json", "text", "clone"].includes(prop)) throw new Error("request body accessed: " + String(prop));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function originContext(body, { status = 200, type = "text/html; charset=UTF-8", extra = {} } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    next: async () => {
      calls += 1;
      return new Response(body, { status, headers: { "content-type": type, etag: '"abc"', "last-modified": "Sat, 19 Sep 2026 00:00:00 GMT", "cache-control": "public,max-age=0,must-revalidate", "x-origin": "1", ...extra } });
    },
  };
}
const nonceOf = (response) => response.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
const scriptOpenTags = (html) => html.match(/<script\b[^>]*>/gi) || [];

describe("eligible route list", () => {
  it("AD_ROUTES is exactly the homepage plus every tool page", () => {
    expect([...AD_ROUTES].sort()).toEqual(["/", ...toolRoutes].sort());
    expect(AD_ROUTES).toHaveLength(36);
  });

  it("config.path is those routes plus each tool's .html file, with no wildcard", () => {
    const expected = ["/", ...toolRoutes.flatMap((route) => [route, route + ".html"])].sort();
    expect([...config.path].sort()).toEqual(expected);
    expect(config.path.some((route) => /[*(]/.test(route))).toBe(false);
  });

  it("never covers privacy, 404, ads.txt, the API, assets or Netlify internals", () => {
    for (const route of ["/privacy-policy", "/privacy-policy.html", "/404", "/404.html", "/ads.txt", "/api/rating", "/js/app.js", "/css/site.css", "/assets/x.png", "/.netlify/scripts/rum", "/robots.txt", "/sitemap.xml", "/_headers", "/_redirects"]) {
      expect(config.path, route).not.toContain(route);
    }
  });

  it("is GET only and bypasses on error", () => {
    expect(config.method).toBe("GET");
    expect(config.onError).toBe("bypass");
  });

  it("every AdSense-enabled built page carries the loader and every route has a page (and nothing else does)", () => {
    const withLoader = ["index.html", ...tools.map((tool) => tool.file)];
    for (const file of withLoader) expect(readText(file), file).toContain("adsbygoogle.js?client=ca-pub-6665490745490381");
    for (const file of ["privacy-policy.html", "404.html"]) expect(readText(file), file).not.toContain("adsbygoogle");
  });
});

describe("nonce", () => {
  it("is 128 bits of base64 (16 random bytes -> 24 chars with padding)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(atob(nonce)).toHaveLength(16);
  });

  it("is unique per response (2000 responses, 2000 different nonces, none reused)", async () => {
    const seen = new Set();
    for (let index = 0; index < 2000; index += 1) {
      const response = await handler(guardedRequest("https://x.test/merge-pdf"), originContext('<script src="a.js"></script>'));
      seen.add(nonceOf(response));
    }
    expect(seen.size).toBe(2000);
  });

  it("the header nonce equals the nonce on every <script> of the real built pages (homepage, PDF, image, converter)", async () => {
    for (const [route, file] of [["/", "index.html"], ["/merge-pdf", "merge-pdf.html"], ["/compress-pdf", "compress-pdf.html"], ["/split-pdf", "split-pdf.html"], ["/edit-pdf", "edit-pdf.html"], ["/resize-image", "resize-image.html"], ["/jpg-to-pdf", "jpg-to-pdf.html"], ["/pdf-to-jpg", "pdf-to-jpg.html"], ["/image-compressor", "image-compressor.html"]]) {
      const original = readText(file);
      const response = await handler(guardedRequest("https://x.test" + route), originContext(original));
      const nonce = nonceOf(response);
      const body = await response.text();
      const tags = scriptOpenTags(body);
      expect(tags.length, file).toBe(scriptOpenTags(original).length);
      expect(tags.length, file).toBeGreaterThan(20);
      for (const tag of tags) expect(tag, file + " " + tag).toContain('nonce="' + nonce + '"');
      // and nothing else about the document changed: removing the attribute restores the original bytes
      expect(body.split(' nonce="' + nonce + '"').join(""), file).toBe(original);
    }
  });

  it("the loader, the JSON-LD data blocks and any injected snippet (e.g. Netlify RUM) all receive the nonce", async () => {
    const html = '<script type="application/ld+json">{"a":1}</script><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6665490745490381" crossorigin="anonymous"></script><script defer src="js/app.js"></script><script async id="netlify-rum-container" src="/.netlify/scripts/rum"></script>';
    const response = await handler(guardedRequest("https://x.test/"), originContext(html));
    const nonce = nonceOf(response);
    const tags = scriptOpenTags(await response.text());
    expect(tags).toHaveLength(4);
    expect(tags.every((tag) => tag.includes('nonce="' + nonce + '"'))).toBe(true);
    expect(tags[0]).toContain('type="application/ld+json"');
  });

  it("addNonce refuses to double-tag, and refuses HTML with no script at all (fail closed)", () => {
    expect(addNonce('<script nonce="x" src="a.js"></script>', "N")).toBeNull();
    expect(addNonce("<p>no scripts</p>", "N")).toBeNull();
    expect(addNonce('<script src="a.js"></script>', "N")).toBe('<script nonce="N" src="a.js"></script>');
  });
});

describe("CSP header", () => {
  const response = async () => handler(guardedRequest("https://x.test/merge-pdf"), originContext('<script src="a.js"></script>'));
  const directives = (policy) => Object.fromEntries(policy.split(";").map((part) => part.trim()).filter(Boolean).map((part) => [part.split(/\s+/)[0], part]));

  it("is the audited nonce policy: nonce + strict-dynamic + the two fallbacks, object-src none, base-uri none", async () => {
    const r = await response();
    const nonce = nonceOf(r);
    const map = directives(r.headers.get("content-security-policy"));
    expect(map["script-src"]).toBe("script-src 'nonce-" + nonce + "' 'strict-dynamic' 'self' https://cdnjs.cloudflare.com");
    expect(map["object-src"]).toBe("object-src 'none'");
    expect(map["base-uri"]).toBe("base-uri 'none'");
  });

  it("equals the enforced static policy in _headers for EVERY other directive (nothing widened or dropped)", async () => {
    const map = directives((await response()).headers.get("content-security-policy"));
    const strict = directives(staticHeaders["Content-Security-Policy"]);
    for (const name of new Set([...Object.keys(map), ...Object.keys(strict)])) {
      if (name === "script-src" || name === "base-uri") continue;
      expect(map[name], name).toBe(strict[name]);
    }
    expect(Object.keys(map).sort()).toEqual(Object.keys(strict).sort());
  });

  it("script-src has no unsafe-inline/unsafe-eval/wildcard/bare https:/http:; the policy has no unsafe-eval, wildcard, Google host, frame-src or connect-src widening", async () => {
    const csp = (await response()).headers.get("content-security-policy");
    const scriptSrc = directives(csp)["script-src"];
    expect(scriptSrc).not.toMatch(/'unsafe-(inline|eval)'/);
    expect(scriptSrc).not.toMatch(/(^|\s)\*(?=\s|$)/);
    expect(scriptSrc).not.toMatch(/(^|\s)https?:(?=\s|$)/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/(^|[\s;])\*(?=[\s;]|$)/);
    expect(csp).not.toMatch(/googlesyndication|doubleclick|adtrafficquality|googleads|google\.com/i);
    expect(csp).not.toMatch(/frame-src|child-src/);
    const map = directives(csp);
    expect(map["connect-src"]).toBe("connect-src 'self' data: blob: https://cdnjs.cloudflare.com");
    expect(map["frame-ancestors"]).toBe("frame-ancestors 'none'");
    expect(map["worker-src"]).toBe("worker-src 'self' blob:");
    expect(map["form-action"]).toBe("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("buildCsp is a pure function of the nonce", () => {
    expect(buildCsp("AAAA")).toBe(buildCsp("AAAA"));
    expect(buildCsp("AAAA")).not.toBe(buildCsp("BBBB"));
  });
});

describe("headers on transformed responses", () => {
  it("re-sets every existing security header with the same value as _headers", async () => {
    const r = await handler(guardedRequest("https://x.test/"), originContext('<script src="a.js"></script>'));
    for (const name of ["Referrer-Policy", "Permissions-Policy", "X-Content-Type-Options", "X-Frame-Options", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "X-XSS-Protection"]) {
      expect(r.headers.get(name), name).toBe(staticHeaders[name]);
      expect(SECURITY_HEADERS[name], name).toBe(staticHeaders[name]);
    }
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("keeps unrelated origin headers and status/content-type", async () => {
    const r = await handler(guardedRequest("https://x.test/"), originContext('<script src="a.js"></script>'));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-origin")).toBe("1");
  });

  it("makes ONLY the nonce-bearing HTML uncacheable: private, no-cache, and no validators that could revalidate a stale nonce", async () => {
    const r = await handler(guardedRequest("https://x.test/"), originContext('<script src="a.js"></script>', { extra: { age: "100", "cache-status": "hit" } }));
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
    for (const name of ["etag", "last-modified", "content-length", "age", "cache-status"]) expect(r.headers.get(name), name).toBeNull();
  });

  it("ships NO debug/diagnostic response header (only the origin's own headers, the security headers, the CSP and Cache-Control)", async () => {
    const origin = originContext('<script src="a.js"></script>');
    const originHeaders = new Set([...(await origin.next()).headers.keys()]);
    const r = await handler(guardedRequest("https://x.test/"), originContext('<script src="a.js"></script>'));
    const allowed = new Set([...originHeaders, ...Object.keys(SECURITY_HEADERS).map((name) => name.toLowerCase()), "content-security-policy", "cache-control"]);
    const extra = [...r.headers.keys()].filter((name) => !allowed.has(name));
    expect(extra).toEqual([]);
    expect([...r.headers.keys()].filter((name) => /debug|invoked|nonce-edge|x-csp/i.test(name))).toEqual([]);
    expect(readText("netlify/edge-functions/csp-nonce.js").replace(/\/\/.*$/gm, "")).not.toMatch(/debug/i);
  });
});

describe("bypass: the function only touches GET requests for eligible HTML", () => {
  const ok = '<script src="a.js"></script>';

  it("POST (and every other method) is returned untouched without even fetching the origin", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const context = originContext(ok);
      const result = await handler(guardedRequest("https://x.test/merge-pdf", method), context);
      expect(result, method).toBeUndefined();
      expect(context.calls, method).toBe(0);
    }
  });

  it("the API, assets, privacy page, 404 route, ads.txt and Netlify internals are never transformed", async () => {
    for (const route of ["/api/rating", "/js/app.js", "/css/site.css", "/assets/vendor/pdf-lib/1.17.1/pdf-lib.min.js", "/privacy-policy", "/privacy-policy.html", "/404.html", "/does-not-exist", "/ads.txt", "/.netlify/scripts/rum", "/merge-pdf/extra"]) {
      const context = originContext(ok);
      expect(await handler(guardedRequest("https://x.test" + route), context), route).toBeUndefined();
      expect(context.calls, route).toBe(0);
    }
  });

  it("non-HTML responses (PDF, image, JSON, JS, CSS) pass through unchanged, same object", async () => {
    for (const type of ["application/pdf", "image/png", "application/json", "application/javascript", "text/css", "application/octet-stream"]) {
      const context = originContext("%PDF-1.7 <script>", { type });
      const result = await handler(guardedRequest("https://x.test/merge-pdf"), context);
      expect(result.headers.get("content-security-policy"), type).toBeNull();
      expect(result.headers.get("content-type")).toBe(type);
      expect(await result.text()).toBe("%PDF-1.7 <script>");
    }
  });

  it("a 404 (or any non-200) HTML response passes through untouched", async () => {
    for (const status of [404, 301, 500, 304]) {
      const result = await handler(guardedRequest("https://x.test/merge-pdf"), originContext(status === 304 ? null : ok, { status }));
      expect(result.status).toBe(status);
      expect(result.headers.get("content-security-policy")).toBeNull();
    }
  });
});

describe("fail closed", () => {
  it("an origin error returns nothing (bypass to the strict static policy), never a weaker header", async () => {
    const result = await handler(guardedRequest("https://x.test/"), { next: async () => { throw new Error("boom"); } });
    expect(result).toBeUndefined();
  });

  it("HTML that cannot be transformed safely returns nothing instead of guessing", async () => {
    expect(await handler(guardedRequest("https://x.test/"), originContext("<p>no scripts</p>"))).toBeUndefined();
    expect(await handler(guardedRequest("https://x.test/"), originContext('<script nonce="pre" src="a.js"></script>'))).toBeUndefined();
  });
});

describe("the function can never receive user files", () => {
  it("never reads a request body (a request whose body accessors throw is handled fine, GET and POST)", async () => {
    await expect(handler(guardedRequest("https://x.test/merge-pdf"), originContext('<script src="a.js"></script>'))).resolves.toBeTruthy();
    await expect(handler(guardedRequest("https://x.test/merge-pdf", "POST"), originContext("x"))).resolves.toBeUndefined();
  });

  it("its source has no body reads, no network calls, no storage, and no file/PDF/image handling", () => {
    const source = readText("netlify/edge-functions/csp-nonce.js").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/request\.(body|arrayBuffer|blob|formData|json|text|clone)\b/);
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|Netlify\.env|getStore|@netlify\/blobs|FormData|Blob\b|ArrayBuffer|multipart|application\/pdf|image\//);
    expect(source).not.toMatch(/\bimport\s/);
  });

  it("the only thing it reads from the request is the method and the URL path", () => {
    const source = readText("netlify/edge-functions/csp-nonce.js").replace(/\/\/.*$/gm, "");
    const requestUses = source.match(/\brequest\.[A-Za-z]+/g) || [];
    expect([...new Set(requestUses)].sort()).toEqual(["request.method", "request.url"]);
  });
});
