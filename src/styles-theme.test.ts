import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheetPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const stylesheet = readFileSync(stylesheetPath, "utf8");

describe("BLAZE navy/red theme contract", () => {
  it("reads the real stylesheet and fails clearly when the file is empty", () => {
    expect(stylesheet.trim().length).toBeGreaterThan(0);
  });

  it("contains only approved blush, navy, red and ember colour literals", () => {
    const approved = new Set([
      "#F4E4E2", "#FAEDEB", "#F7E8E6", "#E2C4C1", "#0F1B33",
      "#4A5370", "#C8202A", "#8E1820", "#FF6A3D", "#0B1426",
      "#13203A", "#1A2A4A", "#2A3A5C", "#F3E6E6", "#B9A9B0",
      "#E0313A", "#F04B53", "#9E1B22",
    ]);
    const literals = [...stylesheet.matchAll(/#[0-9a-f]{3,8}\\b/gi)].map(([value]) => value.toUpperCase());

    expect(literals.length).toBeGreaterThan(0);
    expect(literals.every((value) => approved.has(value))).toBe(true);
    expect(stylesheet).not.toMatch(/--green\\b|--lime\\b/i);
    expect(stylesheet).not.toMatch(/\\bwhite\\b(?!-)|\\bgreen\\b|\\blime\\b/i);
    expect(stylesheet).not.toMatch(/rgba?\\(/i);
  });

  it("defines the requested light and dark palette tokens", () => {
    expect(stylesheet).toContain("--page-bg:#F4E4E2");
    expect(stylesheet).toContain("--surface:#FAEDEB");
    expect(stylesheet).toContain("--surface-raised:#F7E8E6");
    expect(stylesheet).toContain("--line:#E2C4C1");
    expect(stylesheet).toContain("--ink:#0F1B33");
    expect(stylesheet).toContain("--muted:#4A5370");
    expect(stylesheet).toContain("--primary:#C8202A");
    expect(stylesheet).toContain("--primary-deep:#8E1820");
    expect(stylesheet).toContain('--page-bg:#0B1426');
    expect(stylesheet).toContain("--surface:#13203A");
    expect(stylesheet).toContain("--surface-raised:#1A2A4A");
    expect(stylesheet).toContain("--line:#2A3A5C");
    expect(stylesheet).toContain("--ink:#F3E6E6");
    expect(stylesheet).toContain("--muted:#B9A9B0");
    expect(stylesheet).toContain("--primary:#E0313A");
    expect(stylesheet).toContain("--primary-hover:#F04B53");
    expect(stylesheet).toContain("--primary-deep:#9E1B22");
  });

  it("uses the shared surface token for the Member 1 instruction panel", () => {
    expect(stylesheet).toMatch(/\\.creator-member-preview\\s*\\{[^}]*background:\\s*var\\(--surface\\)/s);
  });

  it("uses a deep-red action surface with a theme-aware foreground for AA contrast", () => {
    expect(stylesheet).toMatch(/\\.primary-button\\{[^}]*background:var\\(--primary-deep\\)[^}]*color:var\\(--on-primary\\)/s);
  });
});
