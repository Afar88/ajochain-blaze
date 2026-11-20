import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const bch = readFileSync(new URL("./components/BchMainnetCircleWorkspace.tsx", import.meta.url), "utf8");
const pusd = readFileSync(new URL("./components/PusdMainnetCircleWorkspace.tsx", import.meta.url), "utf8");
const v2 = readFileSync(new URL("./components/V2FeeBchWorkspace.tsx", import.meta.url), "utf8");

describe("Circle network notices", () => {
  it("keeps one exact notice copy for each network at the app circle-area level", () => {
    expect(app.split("Real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts.").length - 1).toBe(1);
    expect(app.split("Test network. No real money.").length - 1).toBe(1);
    expect(app).toContain('<CircleNetworkRiskNotice key={network} network={network} />');
    expect(app).not.toContain("overview-network-notice");
    expect(bch).not.toMatch(/circle rules not audited|independent human audit/i);
    expect(v2).not.toMatch(/Experimental and not audited|test coins only/i);
  });
});

describe("Advanced verification controls", () => {
  it("keeps the Mainnet no-broadcast verification behind a closed Advanced disclosure", () => {
    expect(bch).toMatch(/<details className="advanced-actions" open={advancedOpen}/);
    expect(bch).toMatch(/<summary>Advanced<\/summary>[\s\S]*?Verify Selene signature · no broadcast/);
    expect(bch).toContain('verifyMainnetSignature("action", true)');
    expect(bch).toContain("Sign and send on Mainnet");
  });

  it("keeps the PUSD no-payment approval check behind Advanced", () => {
    expect(pusd).toMatch(/<details className="advanced-actions" open={advancedOpen}/);
    expect(pusd).toMatch(/<summary>Advanced<\/summary>[\s\S]*?Check Selene approval · no payment/);
  });
});
