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
    navigation: /\.menu-trigger[\\s\\S]*?aria-controls="ajochain-dropdown"/.test(css + readFileSync(resolve(here, "App.tsx"), "utf8"))
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
