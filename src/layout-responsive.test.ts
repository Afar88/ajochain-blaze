import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("Responsive layout contract", () => {
  it("uses the mobile, tablet and centred desktop grid at the requested widths", () => {
    const contract = {
      "360px": stylesheet.includes("@media(max-width:767px)") &&
        stylesheet.includes(".overview-status-grid,.circle-choice-grid,.circle-workspace-grid,.classic-workspace-grid,.pusd-mainnet-breakdown-grid{grid-template-columns:minmax(0,1fr)}"),
      "390px": stylesheet.includes("@media(max-width:767px)") &&
        stylesheet.includes(".app-shell *{font-size:max(14px,1em)!important}"),
      "768px": stylesheet.includes("@media(min-width:768px) and (max-width:1199px)") &&
        stylesheet.includes("grid-template-columns:repeat(2,minmax(0,1fr))"),
      "1024px": stylesheet.includes("@media(min-width:768px) and (max-width:1199px)") &&
        stylesheet.includes("grid-template-columns:repeat(2,minmax(0,1fr))"),
      "1440px": stylesheet.includes("@media(min-width:1200px){.page-body{max-width:1280px}") &&
        stylesheet.includes("grid-template-columns:repeat(2,minmax(0,1fr))"),
      "1920px": stylesheet.includes("@media(min-width:1200px){.page-body{max-width:1280px}") &&
        stylesheet.includes("width:min(100%,1280px)"),
    };

    expect(contract).toMatchInlineSnapshot(`
      {
        "1024px": true,
        "1440px": true,
        "1920px": true,
        "360px": true,
        "390px": true,
        "768px": true,
      }
    `);
  });

  it("keeps phone and desktop typography at or above their minimum sizes", () => {
    expect(stylesheet).toContain(".app-shell *{font-size:max(14px,1em)!important}");
    expect(stylesheet).toContain(".app-shell *{font-size:max(13px,1em)!important}");
  });
});
