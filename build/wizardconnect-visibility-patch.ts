/**
 * Patch the published WizardConnect core bundle at Vite's generateBundle stage.
 *
 * @wizardconnect/core@0.2.x hardcodes visibility handling inside
 * initiateDappRelay() and does not forward an enableVisibilityHandling option.
 * Its hidden-page callback closes the relay subscription. Android app switching
 * can race that shutdown against the resume reconnect and leave NDK reporting
 * "Subscription closed". Set the internal option to false so the relay's normal
 * socket-close/reconnect loop owns recovery instead of proactively disconnecting
 * whenever the browser tab becomes hidden.
 *
 * This deliberately matches the exact compiled call site. If WizardConnect
 * changes its implementation, the production build must fail rather than silently
 * shipping the old mobile subscription teardown behaviour.
 */
export const WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE =
  "maxReconnectAttempts:e.maxReconnectAttempts});return{client:a,uri:o,qrUri:c,credentials:i,events:n,cleanup:b}}";

export const WIZARDCONNECT_RELAY_VISIBILITY_REPLACEMENT =
  "maxReconnectAttempts:e.maxReconnectAttempts,enableVisibilityHandling:!1});return{client:a,uri:o,qrUri:c,credentials:i,events:n,cleanup:b}}";

export function patchWizardConnectVisibilityHandling(code: string): string {
  const occurrences = code.split(WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      "Expected exactly one WizardConnect initiateDappRelay reconnect-options call; found " +
      occurrences + ". Review the WizardConnect SDK before updating this patch.",
    );
  }
  return code.replace(
    WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE,
    WIZARDCONNECT_RELAY_VISIBILITY_REPLACEMENT,
  );
}
