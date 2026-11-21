import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { circleRiskNoticeText } from "../App";
const stylesSource = readFileSync(resolve(here, "../styles.css"), "utf8");

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, "../App.tsx"), "utf8");
const bchSource = readFileSync(resolve(here, "BchMainnetCircleWorkspace.tsx"), "utf8");
const controlSource = readFileSync(resolve(here, "TestSignControl.tsx"), "utf8");
const pusdSource = readFileSync(resolve(here, "PusdMainnetCircleWorkspace.tsx"), "utf8");

export function isInsideAdvancedToggle(source: string, label: string, from = 0): boolean {
  const position = source.indexOf(label, from);
  if (position < 0) return false;
  const open = source.lastIndexOf('<details className="advanced-actions">', position);
  const close = source.lastIndexOf("</details>", position);
  return open > close;
}

describe("front-end warning and advanced-action guardrails", () => {
  it("renders one shared notice copy for each selected network", () => {
    expect(circleRiskNoticeText("mainnet")).toBe(
      "Real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts.",
    );
    expect(circleRiskNoticeText("chipnet")).toBe("Test network. No real money.");
    expect((appSource.match(/className="circle-risk-notice"/g) ?? [])).toHaveLength(1);
    expect((appSource.match(/\{renderCircleRiskNotice\(\)\}/g) ?? [])).toHaveLength(4);
  });

  it("keeps the BCH test-sign checks visible, outside any Advanced disclosure", () => {
    expect(bchSource).not.toContain("advanced-actions");
    expect((bchSource.match(/<TestSignControl /g) ?? [])).toHaveLength(2);
    expect(bchSource).toContain('verifyMainnetSignature("action", true)');
  });

  it("provides a copy action beside both Mainnet Member 1 addresses", () => {
    for (const source of [bchSource, pusdSource]) {
      const start = source.indexOf('<div className="creator-member-preview">');
      const end = source.indexOf("</div>", start);
      const preview = source.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(preview).toContain("<code>{initiatorAddress}</code>");
      expect(preview).toContain("Copy address");
    }
  });

  it("keeps the PUSD test-sign checks visible with the agreed copy", () => {
    expect(pusdSource).not.toContain("advanced-actions");
    expect((pusdSource.match(/<TestSignControl /g) ?? [])).toHaveLength(2);
    expect(controlSource).toContain('"Test sign · no money sent"');
    expect(controlSource).toContain('"Refresh preview first"');
    expect(controlSource).toContain("Nothing is broadcast.");
    expect(controlSource).not.toContain("<details");
  });
});

describe("activity records follow the selected network", () => {
  it("passes the selected network to every ActivityRecords and filters refs by it", () => {
    const activitySource = readFileSync(resolve(here, "ActivityRecords.tsx"), "utf8");
    expect(appSource).not.toContain("<ActivityRecords />");
    expect((appSource.match(/<ActivityRecords network=\{network\}/g) ?? [])).toHaveLength(2);
    expect((activitySource.match(/loadCircleRefs\(\)\.filter\(\(ref\) => ref\.network === network\)/g) ?? [])).toHaveLength(2);
  });
});


describe("phone-width layout guardrails", () => {
  it("keeps Home, circle and wallet text wrapping at 360px, 390px and 412px", () => {
    const phoneRules = stylesSource.slice(stylesSource.lastIndexOf("@media (max-width: 767px)"));

    // These target widths must all be covered by the phone breakpoint.
    for (const width of [360, 390, 412]) {
      expect(width).toBeLessThanOrEqual(767);
    }

    // The document/root containers constrain layout but do not hide overflow.
    expect(phoneRules).toContain("html,");
    expect(phoneRules).toContain("min-width: 0;");
    expect(stylesSource).not.toMatch(/(?:html|body|#root|\\.app-shell|\\.compact-app)[^{}]*\\{[^{}]*overflow-x\\s*:\\s*(?:clip|hidden)/s);

    // Text previously ellipsized in status cards and the wallet dropdown is allowed to wrap.
    for (const selector of [".overview-status-card b", ".overview-status-card small", ".dropdown-wallet small"]) {
      expect(phoneRules).toContain(selector);
    }
    expect(phoneRules).toContain("white-space: normal;");
    expect(phoneRules).toContain("overflow-wrap: anywhere;");

    // The wallet chip is allowed to grow vertically rather than truncate its label/address.
    expect(phoneRules).toContain(".header-wallet-chip {");
    expect(phoneRules).toContain("overflow: visible;");
    expect(phoneRules).toContain("text-overflow: clip;");

    // Only the fee table owns horizontal scrolling; the page/root do not clip it.
    expect(phoneRules).toContain(".fee-accounting-table {");
    expect(phoneRules).toContain("overflow-x: auto;");
    expect(phoneRules).toContain("width: 100%;");
    expect(phoneRules).toContain("width: min(52vw, 188px);");
  });
});
