import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Regression coverage for the "npm run seo:check goes stale every day" bug:
// sitemap <lastmod> used to be `new Date()` at generation time, so the
// byte-for-byte check against the committed sitemap.xml failed on every
// calendar day after the last regenerate (and broke the Netlify deploy).
// lastmod now comes from site.lastmod in seo/tools-registry.json.
//
// build/generate-landing.js is a load-time CommonJS script that reads its
// inputs relative to its own location, so these tests run it inside
// throwaway temp copies of just its inputs (build/, seo/, index.html,
// js/core/routing.js) under a fake system clock. Nothing here writes to
// the real checkout.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(resolve(ROOT, "seo/tools-registry.json"), "utf8"));
const SITE_LASTMOD = registry.site.lastmod;

let workRoot;
let shimPath;
let baselineDir; // a fully generated copy (write mode), reused as the starting point for other cases

function makeInputCopy(name) {
  const dir = join(workRoot, name);
  cpSync(resolve(ROOT, "build"), join(dir, "build"), { recursive: true });
  cpSync(resolve(ROOT, "seo"), join(dir, "seo"), { recursive: true });
  cpSync(resolve(ROOT, "index.html"), join(dir, "index.html"));
  cpSync(resolve(ROOT, "js/core/routing.js"), join(dir, "js/core/routing.js"));
  return dir;
}

function copyDir(from, name) {
  const dir = join(workRoot, name);
  cpSync(from, dir, { recursive: true });
  return dir;
}

function runGenerator(dir, { args = [], fakeNow = "2026-06-15T12:00:00Z" } = {}) {
  const result = spawnSync(
    process.execPath,
    ["--require", shimPath, join(dir, "build", "generate-landing.js"), ...args],
    { cwd: dir, encoding: "utf8", env: { ...process.env, FAKE_NOW: fakeNow } }
  );
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function generatedFiles(stdout) {
  return [...stdout.matchAll(/^Generated: (.+)$/gm)].map((m) => m[1].trim());
}

function sitemapLastmods(xml) {
  return [...xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1]);
}

function setSiteLastmod(dir, value, { remove = false } = {}) {
  const file = join(dir, "seo", "tools-registry.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (remove) delete json.site.lastmod;
  else json.site.lastmod = value;
  writeFileSync(file, JSON.stringify(json, null, 2));
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "yoyo-seo-determinism-"));
  // Replaces the global Date with one frozen at $FAKE_NOW for `new Date()`
  // and Date.now() (explicit-argument constructions still work normally),
  // so a run can pretend to happen on any calendar day.
  shimPath = join(workRoot, "fake-date.cjs");
  writeFileSync(
    shimPath,
    [
      "const RealDate = Date;",
      "const frozen = new RealDate(process.env.FAKE_NOW).getTime();",
      "if (Number.isNaN(frozen)) throw new Error('bad FAKE_NOW');",
      "global.Date = class extends RealDate {",
      "  constructor(...args) { if (args.length === 0) super(frozen); else super(...args); }",
      "  static now() { return frozen; }",
      "};",
      ""
    ].join("\n")
  );
  baselineDir = makeInputCopy("baseline");
  const first = runGenerator(baselineDir, { fakeNow: "2026-09-06T00:00:00Z" });
  if (first.status !== 0) throw new Error("baseline generation failed: " + first.stderr);
}, 60_000);

afterAll(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

describe("clock shim sanity", () => {
  it("really freezes new Date() at the simulated day (so the determinism test below is meaningful)", () => {
    for (const fake of ["2026-01-15T08:00:00Z", "2031-12-31T23:00:00Z"]) {
      const out = spawnSync(process.execPath, ["--require", shimPath, "-e", "console.log(new Date().toISOString().slice(0,10))"], {
        encoding: "utf8", env: { ...process.env, FAKE_NOW: fake }
      });
      expect(out.stdout.trim()).toBe(fake.slice(0, 10));
    }
  });
});

describe("SEO output is independent of the calendar date", () => {
  it("generates byte-identical output for every managed file under two different simulated dates", () => {
    const early = makeInputCopy("date-early");
    const late = makeInputCopy("date-late");
    const a = runGenerator(early, { fakeNow: "2026-01-15T08:00:00Z" });
    const b = runGenerator(late, { fakeNow: "2031-12-31T23:00:00Z" });
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);

    const filesA = generatedFiles(a.stdout);
    const filesB = generatedFiles(b.stdout);
    expect(filesA.length).toBeGreaterThan(30); // homepage + sitemap + robots + redirects + routing + every tool page
    expect(filesB).toEqual(filesA);
    for (const file of filesA) {
      const contentA = readFileSync(join(early, file));
      const contentB = readFileSync(join(late, file));
      expect(contentA.equals(contentB), `${file} differs between simulated dates`).toBe(true);
    }
  }, 60_000);

  it("seo:check (--check) passes on a freshly generated tree no matter what day it runs", () => {
    for (const fake of ["2026-01-15T08:00:00Z", "2027-03-01T00:00:00Z", "2035-07-04T12:00:00Z"]) {
      const dir = copyDir(baselineDir, "check-" + fake.slice(0, 10));
      const result = runGenerator(dir, { args: ["--check"], fakeNow: fake });
      expect(result.status, `${fake}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/SEO output is current/);
    }
  }, 60_000);
});

describe("committed sitemap.xml lastmod", () => {
  const xml = readFileSync(resolve(ROOT, "sitemap.xml"), "utf8");
  const lastmods = sitemapLastmods(xml);
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  it("has one valid YYYY-MM-DD lastmod per URL", () => {
    expect(lastmods.length).toBeGreaterThan(0);
    expect(lastmods.length).toBe(locs.length);
    for (const value of lastmods) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const d = new Date(value + "T00:00:00Z");
      expect(d.toISOString().slice(0, 10), value + " is not a real calendar date").toBe(value);
    }
  });

  it("matches site.lastmod from the registry for every URL", () => {
    expect(SITE_LASTMOD).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const value of lastmods) expect(value).toBe(SITE_LASTMOD);
  });
});

describe("site.lastmod fail-fast validation", () => {
  it("fails when site.lastmod is missing", () => {
    const dir = makeInputCopy("missing-lastmod");
    setSiteLastmod(dir, undefined, { remove: true });
    const result = runGenerator(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/site\.lastmod/);
  });

  it.each([
    ["impossible day (Feb 30)", "2026-02-30"],
    ["impossible month (13)", "2026-13-01"],
    ["non-leap-year Feb 29", "2027-02-29"],
    ["missing zero padding", "2026-9-6"],
    ["no separators", "20260906"],
    ["empty string", ""],
    ["trailing time component", "2026-09-06T00:00:00Z"],
    ["a number instead of a string", 20260906]
  ])("fails for an invalid value: %s", (_label, value) => {
    const dir = makeInputCopy("bad-" + String(value).replace(/[^0-9a-z]/gi, "_"));
    setSiteLastmod(dir, value);
    const result = runGenerator(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/site\.lastmod/);
  });

  it("accepts a valid leap day and uses it verbatim in every sitemap entry", () => {
    const dir = makeInputCopy("leap-day");
    setSiteLastmod(dir, "2028-02-29");
    const result = runGenerator(dir);
    expect(result.status, result.stderr).toBe(0);
    const values = sitemapLastmods(readFileSync(join(dir, "sitemap.xml"), "utf8"));
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(["2028-02-29"]));
  });
});

describe("existing SEO validation stays strict", () => {
  it("still flags a stale sitemap.xml (a changed lastmod) as drift", () => {
    const dir = copyDir(baselineDir, "stale-sitemap");
    const file = join(dir, "sitemap.xml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/<lastmod>[^<]*<\/lastmod>/, "<lastmod>1999-01-01</lastmod>"));
    const result = runGenerator(dir, { args: ["--check"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/out of date: .*sitemap\.xml/);
  });

  it("still flags a stale robots.txt and a missing generated page as drift", () => {
    const dir = copyDir(baselineDir, "stale-others");
    writeFileSync(join(dir, "robots.txt"), "User-agent: *\nDisallow: /\n");
    const someTool = readdirSync(dir).find((f) => /^merge-pdf\.html$/.test(f));
    expect(someTool).toBeTruthy();
    rmSync(join(dir, someTool));
    expect(existsSync(join(dir, someTool))).toBe(false);
    const result = runGenerator(dir, { args: ["--check"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/robots\.txt/);
    expect(result.stderr).toMatch(/merge-pdf\.html/);
  });

  it("still rejects registry data that fails the existing site-metadata validation", () => {
    const dir = makeInputCopy("missing-name");
    const file = join(dir, "seo", "tools-registry.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    delete json.site.name;
    writeFileSync(file, JSON.stringify(json, null, 2));
    const result = runGenerator(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Missing site metadata: name/);
  });
});
