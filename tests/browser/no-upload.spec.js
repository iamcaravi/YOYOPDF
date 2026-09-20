import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

// PDF and image processing must stay 100% browser-side. This spec drives each major tool with
// a real file that carries a unique random marker, then proves that the file never left the
// browser:
//   - no request of any kind contains the marker (URL, headers or body, raw / base64 / hex /
//     percent-encoded),
//   - no request has a body and every request is a GET (so nothing could reach the nonce Edge
//     Function, which is GET-only anyway),
//   - no FormData, XMLHttpRequest body, sendBeacon body, fetch body or WebSocket is used by the
//     page's JavaScript,
//   - every request goes to same-origin static files or the pinned CDN / font hosts (the
//     pagead2 AdSense loader tag is stubbed here so the test never contacts Google and is
//     independent of third-party behaviour),
//   - no Content-Security-Policy violation is raised (so this also proves the tools work under
//     the strict nonce CSP when the site is served with it),
//   - and the downloaded output is valid.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const fixture = (name) => readFileSync(resolve(FIXTURES, name));
const ALLOWED_HOSTS = new Set(["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com", "pagead2.googlesyndication.com"]);

// The original fixture bytes followed by a unique marker: PDF readers and image decoders ignore
// trailing bytes, so the tool still processes it, and any leak of the file would carry the marker.
function markedFile(name, mimeType, marker) {
  return { name, mimeType, buffer: Buffer.concat([fixture(name), Buffer.from("\n%" + marker + "\n")]) };
}
const encodings = (marker) => {
  const raw = Buffer.from(marker);
  return [marker, raw.toString("base64").replace(/=+$/, ""), raw.toString("hex"), encodeURIComponent(marker)];
};

async function instrument(page, context, marker) {
  const requests = [];
  const workers = [];
  context.on("request", (request) => {
    const body = request.postDataBuffer();
    requests.push({
      method: request.method(),
      url: request.url(),
      host: new URL(request.url()).host,
      bodyBytes: body ? body.length : 0,
      haystack: request.url() + "\n" + JSON.stringify(request.headers()) + "\n" + (body ? body.toString("latin1") : ""),
    });
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.route(/pagead2\.googlesyndication\.com/, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stub loader */" }));
  await page.addInitScript(() => {
    window.__net = [];
    window.__csp = [];
    const log = (kind, detail) => window.__net.push({ kind, ...detail });
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      log("fetch", { method, hasBody: !!((init && init.body != null) || (input && input.body)) });
      return realFetch.apply(this, arguments);
    };
    const realSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) { log("xhr", { hasBody: body != null }); return realSend.apply(this, arguments); };
    if (navigator.sendBeacon) { const beacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (...args) => { log("beacon", {}); return beacon(...args); }; }
    const RealFormData = window.FormData;
    window.FormData = class extends RealFormData { constructor(...args) { super(...args); log("formdata", {}); } };
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket { constructor(...args) { super(...args); log("websocket", {}); } };
    document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(event.effectiveDirective + " " + event.blockedURI));
  });
  return { requests, workers };
}

async function assertBrowserOnly(page, marker, { requests }) {
  const net = await page.evaluate(() => window.__net);
  const csp = await page.evaluate(() => window.__csp);
  expect(net.filter((entry) => entry.kind !== "fetch"), "no FormData / XHR / sendBeacon / WebSocket use").toEqual([]);
  expect(net.filter((entry) => entry.kind === "fetch" && (entry.method !== "GET" || entry.hasBody)), "no fetch with a body or non-GET method").toEqual([]);
  expect(requests.length).toBeGreaterThan(5);
  expect(requests.filter((request) => request.method !== "GET"), "every request is a GET").toEqual([]);
  expect(requests.filter((request) => request.bodyBytes > 0), "no request has a body").toEqual([]);
  const origin = new URL(page.url()).host;
  expect(requests.filter((request) => request.host !== origin && !ALLOWED_HOSTS.has(request.host)).map((request) => request.url), "only same-origin / pinned CDN / font hosts").toEqual([]);
  for (const needle of encodings(marker)) {
    expect(requests.filter((request) => request.haystack.includes(needle)).map((request) => request.url), "no request carries the uploaded file (" + needle.slice(0, 12) + "...)").toEqual([]);
  }
  expect(csp, "no Content-Security-Policy violations").toEqual([]);
}

async function download(page, selector = "a.dl-link") {
  const link = page.locator(selector).first();
  await expect(link).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent("download");
  await link.click();
  return readFileSync(await (await downloadPromise).path());
}

test.describe("files stay in the browser (no upload, no request carries the file)", () => {
  test("Merge PDF", async ({ page, context }) => {
    test.setTimeout(90_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/merge-pdf");
    await page.locator("#fi").setInputFiles([markedFile("valid.pdf", "application/pdf", marker), markedFile("multipage.pdf", "application/pdf", marker)]);
    await expect(page.locator("#flist .file-card")).toHaveCount(2);
    await page.locator("#go").click();
    const merged = await PDFDocument.load(await download(page));
    expect(merged.getPageCount()).toBe(4);
    await assertBrowserOnly(page, marker, net);
  });

  test("Split PDF", async ({ page, context }) => {
    test.setTimeout(90_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/split-pdf");
    await page.locator("#fi").setInputFiles(markedFile("multipage.pdf", "application/pdf", marker));
    await expect(page.locator('[data-mode="range"]')).toBeVisible();
    await page.locator('[data-rangemode="fixed"]').click();
    await page.locator("#splitEveryN").fill("1");
    await page.locator("#go").click();
    const zip = await JSZip.loadAsync(await download(page));
    expect(Object.keys(zip.files).filter((name) => name.endsWith(".pdf"))).toHaveLength(3);
    await assertBrowserOnly(page, marker, net);
  });

  test("Compress PDF (Web Worker)", async ({ page, context }) => {
    test.setTimeout(150_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/compress-pdf");
    await page.locator("#fi").setInputFiles(markedFile("image-heavy.pdf", "application/pdf", marker));
    await page.locator('#compressLevelPicker .level-row[data-preset="recommended"]').click();
    await page.locator("#go").click();
    const output = await download(page);
    expect((await PDFDocument.load(output)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(net.workers.some((url) => /pdf-compress-worker\.js/.test(url)), "the compression Web Worker still runs").toBe(true);
    await assertBrowserOnly(page, marker, net);
  });

  test("Edit PDF (lazy-loaded editor scripts)", async ({ page, context }) => {
    test.setTimeout(90_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/edit-pdf");
    await page.locator("#fi").setInputFiles(markedFile("valid.pdf", "application/pdf", marker));
    await expect(page.locator('.editor-canvas[data-state="page"]')).toBeVisible({ timeout: 30_000 });
    const editorScripts = net.requests.filter((request) => /\/js\/editor\/editor-[a-z-]+\.js/.test(request.url));
    expect(editorScripts.length, "the editor's dynamically inserted scripts loaded").toBeGreaterThan(5);
    await assertBrowserOnly(page, marker, net);
  });

  test("JPG/PNG to PDF", async ({ page, context }) => {
    test.setTimeout(60_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/jpg-to-pdf");
    await page.locator("#fi").setInputFiles(markedFile("simple.png", "image/png", marker));
    await page.locator("#go").click();
    expect((await PDFDocument.load(await download(page))).getPageCount()).toBe(1);
    await assertBrowserOnly(page, marker, net);
  });

  test("PDF to JPG", async ({ page, context }) => {
    test.setTimeout(60_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/pdf-to-jpg");
    await page.locator("#fi").setInputFiles(markedFile("valid.pdf", "application/pdf", marker));
    await expect(page.locator("#go")).toBeVisible();
    await page.locator("#go").click();
    const bytes = await download(page);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    await assertBrowserOnly(page, marker, net);
  });

  test("Resize image", async ({ page, context }) => {
    test.setTimeout(60_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/resize-image");
    await page.locator("#fi").setInputFiles(markedFile("simple.png", "image/png", marker));
    await page.locator("#rw").fill("40");
    await page.locator("#rh").fill("40");
    await page.locator("#go").click();
    const bytes = await download(page);
    expect(bytes.readUInt32BE(16)).toBe(40);
    expect(bytes.readUInt32BE(20)).toBe(40);
    await assertBrowserOnly(page, marker, net);
  });

  test("Image compressor", async ({ page, context }) => {
    test.setTimeout(60_000);
    const marker = "UPLOADMARK" + randomBytes(12).toString("hex");
    const net = await instrument(page, context, marker);
    await page.goto("/image-compressor");
    await page.locator("#fi").setInputFiles(markedFile("simple.png", "image/png", marker));
    await page.locator("#targetKb").fill("50");
    await page.locator("#go").click();
    const bytes = await download(page);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes.toString("hex", 0, 4) === "89504e47";
    expect(isJpeg || isPng).toBe(true);
    await assertBrowserOnly(page, marker, net);
  });
});
