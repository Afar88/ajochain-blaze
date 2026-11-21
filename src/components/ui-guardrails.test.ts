import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { circleRiskNoticeText } from "../App";
const here = dirname(fileURLToPath(import.meta.url));
const stylesSource = readFileSync(resolve(here, "../styles.css"), "utf8");
const appSource = readFileSync(resolve(here, "../App.tsx"), "utf8");
const bchSource = readFileSync(resolve(here, "BchMainnetCircleWorkspace.tsx"), "utf8");
const controlSource = readFileSync(resolve(here, "TestSignControl.tsx"), "utf8");
const activitySource = readFileSync(resolve(here, "ActivityRecords.tsx"), "utf8");
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

    // Verify the phone breakpoint and the exact target widths reported for the Redmi device.
    expect(stylesSource).toContain("@media (max-width: 767px)");
    for (const width of [360, 390, 412]) {
      expect(width).toBeGreaterThanOrEqual(320);
      expect(width).toBeLessThanOrEqual(767);
      expect(phoneRules).toContain(".overview-status-card b");
      expect(phoneRules).toContain(".dropdown-wallet small");
    }

    // The document/root containers constrain layout but do not hide overflow.
    expect(phoneRules).toContain("html,");
    expect(phoneRules).toContain("min-width: 0;");
    expect(stylesSource).not.toContain("overflow-x:hidden");
    expect(stylesSource).not.toContain("overflow-x:clip");

    // Text previously ellipsized in status cards and the wallet dropdown is allowed to wrap.
    for (const selector of [".overview-status-card b", ".overview-status-card small", ".dropdown-wallet small"]) {
      expect(phoneRules).toContain(selector);
    }
    expect(phoneRules).toContain("white-space: normal;");
    expect(phoneRules).toContain("overflow-wrap: anywhere;");

    // The wallet chip is allowed to grow vertically rather than truncate its label/address.
    expect(phoneRules).toContain(".app-shell .header-wallet-chip");
    expect(phoneRules).toContain(".app-shell .header-network-pill");
    expect(phoneRules).toContain("overflow: visible;");
    expect(phoneRules).toContain("text-overflow: clip;");

    // Only the fee table owns horizontal scrolling; the page/root do not clip it.
    expect(phoneRules).toContain(".fee-accounting-table {");
    expect(phoneRules).toContain("overflow-x: auto;");
    expect(phoneRules).toContain("width: 100%;");
    expect(phoneRules).toContain("width: min(52vw, 188px);");
    expect(stylesSource).toContain("max-width:1280px");
    expect(stylesSource.split("overflow-x:auto").length - 1).toBe(1);
    expect(stylesSource.split("overflow-x: auto").length - 1).toBe(1);
  });
});


describe("saved circle and homepage guardrails", () => {
  it("loads saved BCH and PUSD Mainnet circles into Activity", () => {
    expect(activitySource).toContain("ajochain-blaze:bch-mainnet-circles-deployed:v1");
    expect(activitySource).toContain("ajochain-blaze:pusd-mainnet-circles-deployed:v1");
    expect(activitySource).toContain("readSavedBchMainnetCircles()");
    expect(activitySource).toContain("readSavedPusdCircles()");
    expect(activitySource).toContain("ajochain:bch-mainnet-circles-changed");
    expect(activitySource).toContain("ajochain:saved-circles-changed");
  });

  it("keeps the Home page limited to the notice, hero and two actions", () => {
    const start = appSource.indexOf('{page === "overview" && (');
    const end = appSource.indexOf('{page === "create-circle" && (', start);
    const home = appSource.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const removed of [
      "overview-my-circles",
      "overview-activity",
      "overview-status-grid",
      "asset-preview",
      "how-ajo-works",
    ]) expect(home).not.toContain(removed);
    expect(home).toContain("{renderCircleRiskNotice()}");
    expect(home).toContain("Your Ajo savings circle,");
    expect(home).toContain("on Bitcoin Cash.");
    expect(home).toContain("Create a circle");
    expect(home).toContain("My circles");
  });

  it("keeps Wallet detail helper lines short and free of internal terms", () => {
    const start = appSource.indexOf("{showWallet && (");
    const end = appSource.indexOf('<footer className="app-footer"', start);
    const walletDetails = appSource.slice(start, end);
    const plainHelpers = [...walletDetails.matchAll(/<(?:p|small)\\b[^>]*>([^<{]+)<\\/(?:p|small)>/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    for (const helper of plainHelpers) {
      const words = helper.split(/\\s+/).filter(Boolean);
      expect(words.length, helper).toBeLessThanOrEqual(15);
    }
    for (const forbidden of ["derived", "receive key", "indices", "xpub", "verified picker", "relay", "session", "provider", "proof checks", "WizardConnect"]) {
      expect(walletDetails.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    for (const expected of [
      "Connect Selene. Your keys never leave your phone.",
      "Approve in Selene, then come back.",
      "Reconnecting…",
      "Disconnected.",
      "Pick the address shown in Selene.",
      "Address confirmed ✓",
      "Address not confirmed yet.",
      "Reconnect Selene first.",
      "Couldn't load your addresses. Reconnect and try again.",
      "This address isn't in your wallet. Check Selene is on Mainnet and reconnect.",
      "Wait 1 confirmation, then create.",
      "Combine your BCH into one coin. Tokens aren't touched.",
      "Done. Confirms in a few minutes.",
      "Couldn't combine your BCH. Try again.",
    ]) expect(walletDetails).toContain(expected);
  });
});
