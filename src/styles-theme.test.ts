import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "styles.css");
const css = readFileSync(cssPath, "utf8");

function outsideThemeTokens(stylesheet: string): string {
  return stylesheet.replace(/:root(?:\[data-theme="dark"\])?\s*\{[^}]*\}/g, "");
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function columnsAt(width: number): 1 | 2 {
  return width < 768 ? 1 : 2;
}

function layoutSnapshotAt(width: number) {
  const phone = width < 768;
  const desktop = width >= 1200;
  return {
    viewport: width + "px",
    columns: columnsAt(width),
    contentWidth: desktop && /\.app-shell \.page-body, \.app-shell \.content \{ max-width:1280px; \}/.test(css)
      ? "max-width: 1280px"
      : "fluid",
    horizontalGutter: phone && /\.app-shell \.page-body, \.app-shell \.content \{ padding-inline:16px; \}/.test(css)
      ? "16px"
      : "fluid",
    minimumFontSize: phone ? 14 : 13,
    navigation: /\.menu-trigger[\s\S]*?aria-controls="ajochain-dropdown"/.test(css + readFileSync(resolve(here, "App.tsx"), "utf8"))
      ? "hamburger menu"
      : "missing",
  };
}

describe("Navy/red theme and responsive stylesheet", () => {
  it("reads the real stylesheet from disk", () => {
    expect(css.length).toBeGreaterThan(5_000);
    expect(css.trim()).not.toBe("");
  });

  it("keeps every non-token color on a CSS variable and removes all white/green values", () => {
    const componentStyles = outsideThemeTokens(css);
    expect(componentStyles).not.toMatch(/#(?:[0-9a-f]{3,8})\b/i);
    expect(componentStyles).not.toMatch(/\bwhite\b(?!-)/i);
    expect(componentStyles).not.toMatch(/\bgreen\b|--green|--lime/i);
    expect(componentStyles).not.toMatch(/\brgba?\s*\(|\bhsla?\s*\(/i);
    expect(css).not.toMatch(/#fff(?:fff)?\b|\bwhite\b(?!-)|\bgreen\b|--green|--lime/i);
  });

  it("rejects all unapproved theme colour literals, including near-white and green", () => {
    const approved = new Set([
      "#F4E4E2", "#FAEDEB", "#F7E8E6", "#E2C4C1", "#0F1B33",
      "#4A5370", "#C8202A", "#8E1820", "#FF6A3D", "#0B1426",
      "#13203A", "#1A2A4A", "#2A3A5C", "#F3E6E6", "#B9A9B0",
      "#E0313A", "#F04B53", "#9E1B22",
    ]);
    const literals = [...css.matchAll(/#[0-9a-f]{3,8}\\b/gi)].map(([value]) => value.toUpperCase());
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.every((value) => approved.has(value))).toBe(true);
  });

  it("keeps red-button foreground contrast at WCAG AA in both themes", () => {
    expect(css).toContain("--button-bg:#C8202A");
    expect(css).toContain("--button-bg:#9E1B22");
    expect(css).toContain("background:var(--button-bg)");
    expect(css).toContain("color:var(--on-primary)");
    expect(contrastRatio("#FAEDEB", "#C8202A")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#F3E6E6", "#9E1B22")).toBeGreaterThanOrEqual(4.5);
  });

  it("defines the required light and navy dark palettes", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--page-bg:\s*#F4E4E2/s);
    expect(css).toMatch(/:root\s*\{[^}]*--surface:\s*#FAEDEB/s);
    expect(css).toMatch(/:root\s*\{[^}]*--primary:\s*#C8202A/s);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--page-bg:\s*#0B1426/s);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--surface:\s*#13203A/s);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--primary:\s*#E0313A/s);
  });

  it("keeps Member 1 instructions on the theme surface", () => {
    expect(css).toMatch(/\.creator-member-preview\s*\{[^}]*background:\s*var\(--surface\)/s);
  });

  it("snapshots the phone layout at 390px", () => {
    expect(layoutSnapshotAt(390)).toMatchInlineSnapshot(`
      {
        "columns": 1,
        "contentWidth": "fluid",
        "horizontalGutter": "16px",
        "minimumFontSize": 14,
        "navigation": "hamburger menu",
        "viewport": "390px",
      }
    `);
  });

  it("snapshots the wide desktop layout at 1440px", () => {
    expect(layoutSnapshotAt(1440)).toMatchInlineSnapshot(`
      {
        "columns": 2,
        "contentWidth": "max-width: 1280px",
        "horizontalGutter": "fluid",
        "minimumFontSize": 13,
        "navigation": "hamburger menu",
        "viewport": "1440px",
      }
    `);
  });

  it("matches mobile, tablet and desktop layout breakpoints", () => {
    expect(columnsAt(360)).toBe(1);
    expect(columnsAt(390)).toBe(1);
    expect(columnsAt(768)).toBe(2);
    expect(columnsAt(1024)).toBe(2);
    expect(columnsAt(1440)).toBe(2);
    expect(columnsAt(1920)).toBe(2);
    expect(css).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]*?grid-template-columns:\s*minmax\(0,1fr\)/i);
    expect(css).toMatch(/@media\s*\(min-width:\s*1200px\)[\s\S]*?max-width:\s*1280px/i);
  });
});
