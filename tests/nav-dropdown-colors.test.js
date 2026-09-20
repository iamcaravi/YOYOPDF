import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The desktop navigation dropdown (mega menu + Convert PDF menu) resting tool text/icon colours use two
// dedicated tokens instead of the site-wide --ink-soft, which was too faint there. These tests pin the tokens,
// where they are used, that --ink-soft and the hover/disabled looks are untouched, and the resulting contrast.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(ROOT, "css/site.css"), "utf8").replace(/\r\n/g, "\n");
const rootBlock = css.slice(css.indexOf(":root{"), css.indexOf("[data-theme=\"dark\"]{"));
const darkBlock = css.slice(css.indexOf("[data-theme=\"dark\"]{"), css.indexOf("[data-theme=\"dark\"]{") + 3000);

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

describe("navigation dropdown link colours", () => {
  it("defines the light and dark tokens in the existing theme sections", () => {
    expect(rootBlock).toContain("--nav-link-ink:#334155;");
    expect(rootBlock).toContain("--nav-link-icon:#475569;");
    expect(darkBlock).toContain("--nav-link-ink:#C4C4C0;");
    expect(darkBlock).toContain("--nav-link-icon:#B4B4B0;");
    expect((css.match(/--nav-link-ink:/g) || []).length).toBe(2);
    expect((css.match(/--nav-link-icon:/g) || []).length).toBe(2);
  });

  it("--ink-soft is unchanged in both themes", () => {
    expect(rootBlock).toContain("--ink-soft:#64748B;");
    expect(darkBlock).toContain("--ink-soft:#9A9A96;");
    expect((css.match(/--ink-soft:#[0-9A-Fa-f]{6};/g) || []).sort()).toEqual(["--ink-soft:#64748B;", "--ink-soft:#9A9A96;"]);
  });

  it("the resting rules of the dropdown use the new tokens - and nothing else does", () => {
    expect(css).toMatch(/\.nav-dd-menu button\{[^}]*color:var\(--nav-link-ink\)[^}]*\}/);
    expect(css).toContain(".nav-dd-menu .mega-tool-icon{ color:var(--nav-link-icon); }");
    expect(css).toMatch(/\.mega-col-list button\{[^}]*color:var\(--nav-link-ink\)[^}]*\}/);
    expect(css).toContain(".mega-tool-icon{ width:16px; height:16px; flex:none; color:var(--nav-link-icon); }");
    expect((css.match(/var\(--nav-link-(ink|icon)\)/g) || []).length).toBe(4);
  });

  it("hover and focus keep the existing brand colour (--red: light blue / dark lime); no new focus design", () => {
    expect(css).toContain(".nav-dd-menu button:hover, .nav-dd-menu button:focus-visible{ background:var(--paper-dim); color:var(--red); outline:none; }");
    expect(css).toContain(".nav-dd-menu button:hover .mega-tool-icon, .nav-dd-menu button:focus-visible .mega-tool-icon{ color:var(--red); }");
    expect(css).toContain(".mega-col-list button:hover{ background:var(--paper-dim); color:var(--red); }");
    expect(css).toContain(".mega-col-list button:hover .mega-tool-icon{ color:var(--red); }");
  });

  it("the disabled 'coming soon' items keep their original dimmed look (--ink-soft at 0.6 opacity)", () => {
    expect(css).toContain(".mega-col-list button[disabled]{ cursor:default; opacity:0.6; color:var(--ink-soft); }");
    expect(css).toContain(".mega-col-list button[disabled] .mega-tool-icon{ color:var(--ink-soft); }");
    expect(css).toContain(".mega-col-list button[disabled]:hover{ background:none; color:var(--ink-soft); }");
  });

  it("header nav links, footer and the mobile accordion are not touched by the new tokens", () => {
    expect(css).toMatch(/\.nav-tool\{[^}]*color:var\(--ink-soft\)/);
    expect(css).toMatch(/\.nav-dd-trigger\{[^}]*color:var\(--ink-soft\)/);
    expect(css).toMatch(/\.mm-tool\{[^}]*color:var\(--ink-soft\)/);
    expect(css).toMatch(/\.mobile-menu button\{[^}]*color:var\(--ink\)/);
  });

  it("contrast on the dropdown card: text >= 10:1 and icons >= 7:1 in both themes (WCAG AA needs 4.5:1 text, 3:1 icons)", () => {
    expect(contrast("#334155", "#FFFFFF")).toBeGreaterThan(10.3);
    expect(contrast("#475569", "#FFFFFF")).toBeGreaterThan(7.5);
    expect(contrast("#C4C4C0", "#101010")).toBeGreaterThan(10.8);
    expect(contrast("#B4B4B0", "#101010")).toBeGreaterThan(9.1);
    // and clearly stronger than the old --ink-soft
    expect(contrast("#334155", "#FFFFFF")).toBeGreaterThan(contrast("#64748B", "#FFFFFF") * 2);
    // headings (--ink) stay visually stronger than the links
    expect(contrast("#111827", "#FFFFFF")).toBeGreaterThan(contrast("#334155", "#FFFFFF"));
    expect(contrast("#F2F2F0", "#101010")).toBeGreaterThan(contrast("#C4C4C0", "#101010"));
  });
});
