import { describe, expect, it } from "vitest";
import {
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

  it("fails closed if the SDK call site is duplicated", () => {
    const duplicated = WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE + ";" +
      WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE;
    expect(() => patchWizardConnectVisibilityHandling(duplicated))
      .toThrow(/found 2/);
  });
});
