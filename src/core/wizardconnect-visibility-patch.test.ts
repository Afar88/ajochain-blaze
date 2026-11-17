import { describe, expect, it } from "vitest";
import {
  hasWizardConnectVisibilityTarget,
  patchWizardConnectVisibilityHandling,
  WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE,
  WIZARDCONNECT_RELAY_VISIBILITY_REPLACEMENT,
} from "../../build/wizardconnect-visibility-patch";

describe("WizardConnect visibility recovery bundle patch", () => {
  it("disables proactive hidden-tab relay teardown at initiateDappRelay", () => {
    const input = "prefix;" + WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE + ";suffix";
    const patched = patchWizardConnectVisibilityHandling(input);

    expect(patched).toContain(WIZARDCONNECT_RELAY_VISIBILITY_REPLACEMENT);
    expect(patched).not.toContain(WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE);
  });

  it("fails closed when the published SDK call site changes", () => {
    expect(() => patchWizardConnectVisibilityHandling("unexpected SDK output"))
      .toThrow(/Expected exactly one WizardConnect initiateDappRelay/);
  });


  it("matches minifier-renamed locals and preserves existing option commas", () => {
    const input = "const relay = initiateDappRelay({maxReconnectAttempts:options.maxReconnectAttempts,debug:true});";
    expect(hasWizardConnectVisibilityTarget(input)).toBe(true);
    expect(patchWizardConnectVisibilityHandling(input)).toBe(
      "const relay = initiateDappRelay({maxReconnectAttempts:options.maxReconnectAttempts,enableVisibilityHandling:!1,debug:true});",
    );
  });

  it("matches formatted reconnect options while remaining specific to the SDK setting", () => {
    const input = "initiateDappRelay({ maxReconnectAttempts : config.maxReconnectAttempts });";
    expect(hasWizardConnectVisibilityTarget(input)).toBe(true);
    expect(patchWizardConnectVisibilityHandling(input)).toContain(
      "maxReconnectAttempts : config.maxReconnectAttempts,enableVisibilityHandling:!1",
    );
  });

  it("does not match a static max reconnect value or unrelated visibility text", () => {
    expect(hasWizardConnectVisibilityTarget("maxReconnectAttempts:5")).toBe(false);
    expect(hasWizardConnectVisibilityTarget("visibilityHandling:false")).toBe(false);
  });

  it("fails closed if the SDK call site is duplicated", () => {
    const duplicated = WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE + ";" +
      WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE;
    expect(() => patchWizardConnectVisibilityHandling(duplicated))
      .toThrow(/found 2/);
  });
});
