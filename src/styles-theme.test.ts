import { describe, expect, it } from "vitest";
import stylesheet from "./styles.css?raw";

describe("BLAZE theme-aware surfaces", () => {
  it("does not hard-code pure white as a component background or border", () => {
    expect(stylesheet).not.toMatch(/\bbackground(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)(?=\s*(?:;|}))/i);
    expect(stylesheet).not.toMatch(/\bborder(?:-[a-z]+)?\s*:[^;{}]*\bwhite\b/i);
  });

  it("defines separate light and dark surface tokens", () => {
    expect(stylesheet).toMatch(/:root\s*\{[^}]*--surface:\s*#FFFFFF/s);
    expect(stylesheet).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--surface:\s*#281D1F/s);
  });

  it("uses the theme surface for the Member 1 instruction panel", () => {
    expect(stylesheet).toMatch(/\.creator-member-preview\s*\{[^}]*background:\s*var\(--surface\)/s);
  });
});
