// Netlify Edge Function: per-response CSP nonce for the AdSense-enabled HTML pages.
//
// WHAT THIS DOES (and nothing else): for a GET of one of the eligible HTML routes below
// it takes the static HTML response, adds a fresh random nonce to every <script> tag, and
// sets the matching Content-Security-Policy plus the site's security headers.
//
// WHAT THIS NEVER DOES: it never reads a request body, never sees an uploaded file, and
// never touches PDF/image/API/asset requests. PDF and image processing is 100%
// browser-side (YOYOPDF JavaScript + Web Workers) and does not go through this function:
// the function is GET-only (config.method), scoped to the HTML routes in `config.path`, and
// the handler additionally refuses anything else.
//
// WHY A NONCE: Google supports AdSense only under a strict, nonce-based CSP
// (https://support.google.com/adsense/answer/16283098) because the hosts its scripts use
// change over time. 'strict-dynamic' lets the nonce-bearing loader load what it needs,
// so no Google host allowlist is kept. frame-src/connect-src are deliberately NOT widened
// here: the real ad chain has not been validated yet (see docs in _headers).
//
// FAIL CLOSED: on any error or any response this function cannot fully transform, it
// returns nothing (config.onError is also "bypass"), so the static response is served
// with the strict policy from _headers - never a weaker one.
//
// Keep AD_ROUTES in sync with the pages that carry the loader (index.html + every tool
// page); tests/csp-nonce-edge.test.js fails if they drift.

export const AD_ROUTES = [
  "/",
  "/add-blank-page",
  "/compress-pdf",
  "/convert-image-format",
  "/crop-image",
  "/crop-pdf",
  "/delete-pages",
  "/edit-pdf",
  "/excel-to-pdf",
  "/extract-pages",
  "/fill-pdf-form",
  "/flatten-pdf",
  "/header-footer",
  "/image-compressor",
  "/invert-image-colors",
  "/invert-pdf-colors",
  "/jpg-to-pdf",
  "/merge-excel",
  "/merge-pdf",
  "/organize-pdf",
  "/page-numbers",
  "/pdf-to-excel",
  "/pdf-to-jpg",
  "/pdf-to-powerpoint",
  "/pdf-to-word",
  "/protect-pdf",
  "/reorder-pages",
  "/repair-pdf",
  "/resize-image",
  "/rotate-pdf",
  "/sign-pdf",
  "/split-pdf",
  "/unlock-pdf",
  "/watermark-image",
  "/watermark-pdf",
  "/word-to-pdf",
];

// Clean URL plus the direct .html file URL of each tool page (the homepage has one URL).
// Netlify does not run an edge function on the target of a static rewrite, so the clean
// URL must be declared explicitly.
export const config = {
  path: [
    "/",
    "/add-blank-page", "/add-blank-page.html",
    "/compress-pdf", "/compress-pdf.html",
    "/convert-image-format", "/convert-image-format.html",
    "/crop-image", "/crop-image.html",
    "/crop-pdf", "/crop-pdf.html",
    "/delete-pages", "/delete-pages.html",
    "/edit-pdf", "/edit-pdf.html",
    "/excel-to-pdf", "/excel-to-pdf.html",
    "/extract-pages", "/extract-pages.html",
    "/fill-pdf-form", "/fill-pdf-form.html",
    "/flatten-pdf", "/flatten-pdf.html",
    "/header-footer", "/header-footer.html",
    "/image-compressor", "/image-compressor.html",
    "/invert-image-colors", "/invert-image-colors.html",
    "/invert-pdf-colors", "/invert-pdf-colors.html",
    "/jpg-to-pdf", "/jpg-to-pdf.html",
    "/merge-excel", "/merge-excel.html",
    "/merge-pdf", "/merge-pdf.html",
    "/organize-pdf", "/organize-pdf.html",
    "/page-numbers", "/page-numbers.html",
    "/pdf-to-excel", "/pdf-to-excel.html",
    "/pdf-to-jpg", "/pdf-to-jpg.html",
    "/pdf-to-powerpoint", "/pdf-to-powerpoint.html",
    "/pdf-to-word", "/pdf-to-word.html",
    "/protect-pdf", "/protect-pdf.html",
    "/reorder-pages", "/reorder-pages.html",
    "/repair-pdf", "/repair-pdf.html",
    "/resize-image", "/resize-image.html",
    "/rotate-pdf", "/rotate-pdf.html",
    "/sign-pdf", "/sign-pdf.html",
    "/split-pdf", "/split-pdf.html",
    "/unlock-pdf", "/unlock-pdf.html",
    "/watermark-image", "/watermark-image.html",
    "/watermark-pdf", "/watermark-pdf.html",
    "/word-to-pdf", "/word-to-pdf.html",
  ],
  method: "GET",
  onError: "bypass",
};

const ELIGIBLE_PATHS = new Set(config.path);

// Must equal the enforced policy in _headers ("/*") except for script-src and base-uri
// (tests/csp-nonce-edge.test.js compares them directive by directive).
export function buildCsp(nonce) {
  return [
    "default-src 'self'",
    "script-src 'nonce-" + nonce + "' 'strict-dynamic' 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' data: blob: https://cdnjs.cloudflare.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

// Set explicitly because Netlify's docs say custom (_headers) headers are not applied to
// edge-function output. Values are identical to the "/*" rule in _headers.
export const SECURITY_HEADERS = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-XSS-Protection": "0",
};

// 128 bits from the Web Crypto CSPRNG, base64-encoded (a valid CSP base64-value).
export function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const SCRIPT_OPEN_TAG = /<script\b[^>]*>/gi;

// Adds nonce="..." to every <script> open tag (executable scripts AND the JSON-LD data
// blocks: a nonce on a data block is harmless and keeps the rule "every script is tagged"
// trivially checkable). Returns null if the markup is not what we expect, so the caller
// fails closed instead of guessing.
export function addNonce(html, nonce) {
  if (/<script\b[^>]*\snonce\s*=/i.test(html)) return null; // never double-tag
  let count = 0;
  const out = html.replace(/<script\b/gi, () => { count += 1; return '<script nonce="' + nonce + '"'; });
  if (count === 0) return null;
  const tags = out.match(SCRIPT_OPEN_TAG) || [];
  if (tags.length !== count || !tags.every((tag) => tag.includes('nonce="' + nonce + '"'))) return null;
  return out;
}

export default async function handler(request, context) {
  try {
    if (request.method !== "GET") return undefined;
    if (!ELIGIBLE_PATHS.has(new URL(request.url).pathname)) return undefined;

    const response = await context.next();
    const type = response.headers.get("content-type") || "";
    if (response.status !== 200 || !type.toLowerCase().startsWith("text/html")) return response;

    const nonce = generateNonce();
    const html = addNonce(await response.text(), nonce);
    if (html === null) return undefined;

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    headers.set("Content-Security-Policy", buildCsp(nonce));
    // Nonce-bearing HTML must never be stored/reused: a cached copy would carry an old
    // nonce (or hand one visitor's nonce to another). Only this HTML is affected.
    headers.set("Cache-Control", "private, no-cache");
    for (const name of ["ETag", "Last-Modified", "Content-Length", "Age", "Cache-Status"]) headers.delete(name);
    return new Response(html, { status: 200, headers });
  } catch {
    return undefined; // bypass: the static strict policy applies
  }
}
