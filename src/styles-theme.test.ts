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

describe("Navy/red theme and responsive stylesheet", () => {
  it("reads the real stylesheet from disk", () => {
    expect(css.length).toBeGreaterThan(5_000);
    expect(css.trim()).not.toBe("");
  });

  it("keeps every non-token color on a CSS variable", () => {
    const componentStyles = outsideThemeTokens(css);
    expect(componentStyles).not.toMatch(/#(?:[0-9a-f]{3,8})\b/i);
    expect(componentStyles).not.toMatch(/\bwhite\b(?!-)/i);
    expect(componentStyles).not.toMatch(/\bgreen\b|--green|--lime/i);
    expect(componentStyles).not.toMatch(/\brgba?\s*\(|\bhsla?\s*\(/i);
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

  it("matches mobile and desktop layout snapshots at 390px and 1440px", () => {
    expect(columnsAt(390)).toBe(1);
    expect(columnsAt(1440)).toBe(2);
    expect(css).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]*?grid-template-columns:\s*minmax\(0,1fr\)/i);
    expect(css).toMatch(/@media\s*\(min-width:\s*1200px\)[\s\S]*?max-width:\s*1280px/i);
  });
});
