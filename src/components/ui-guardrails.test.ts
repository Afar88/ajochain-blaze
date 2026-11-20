import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { circleRiskNoticeText } from "../App";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, "../App.tsx"), "utf8");
const bchSource = readFileSync(resolve(here, "BchMainnetCircleWorkspace.tsx"), "utf8");
const pusdSource = readFileSync(resolve(here, "PusdMainnetCircleWorkspace.tsx"), "utf8");

function isInsideAdvancedToggle(source: string, label: string, from = 0): boolean {
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

  it("keeps both BCH dry-run checks inside a collapsed Advanced disclosure", () => {
    expect(isInsideAdvancedToggle(bchSource, "Check Selene approval · no payment")).toBe(true);
    expect(isInsideAdvancedToggle(bchSource, "Verify Selene signature · no broadcast")).toBe(true);
    expect((bchSource.match(/<details className="advanced-actions">/g) ?? [])).toHaveLength(2);
  });

  it("provides a copy action beside both Mainnet Member 1 addresses", () => {
    expect(bch).toMatch(/<div className="creator-member-preview">[\\s\\S]*?<code>\\{initiatorAddress\\}<\\/code>[\\s\\S]*?Copy address/);
    expect(pusd).toMatch(/<div className="creator-member-preview">[\\s\\S]*?<code>\\{initiatorAddress\\}<\\/code>[\\s\\S]*?Copy address/);
  });

  it("keeps both PUSD dry-run checks inside a collapsed Advanced disclosure", () => {
    const label = "Check Selene approval · no payment";
    const positions = [...pusdSource.matchAll(new RegExp(label, "g"))].map((match) => match.index ?? -1);
    expect(positions).toHaveLength(2);
    for (const position of positions) {
      const open = pusdSource.lastIndexOf('<details className="advanced-actions">', position);
      const close = pusdSource.lastIndexOf("</details>", position);
      expect(open).toBeGreaterThan(close);
    }
    expect((pusdSource.match(/<details className="advanced-actions">/g) ?? [])).toHaveLength(2);
  });
});
