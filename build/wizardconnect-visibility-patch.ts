/**
 * Patch the published WizardConnect core bundle at Vite's renderChunk stage.
 *
 * @wizardconnect/core@0.2.x exposes the hidden-tab teardown option only at
 * initiateDappRelay's reconnect-options object. Browser app switching can race
 * that proactive shutdown against the resume reconnect and leave the relay
 * subscription closed. Set enableVisibilityHandling=false so the normal socket
 * reconnect lifecycle owns recovery.
 *
 * Rollup/minifier versions can rename local variables and reformat the object.
 * Match the semantic maxReconnectAttempts property rather than one exact
 * minified variable spelling. The build still fails closed unless exactly one
 * such SDK option is found and patched.
 */
export const WIZARDCONNECT_RELAY_VISIBILITY_NEEDLE =
  "maxReconnectAttempts:e.maxReconnectAttempts";

export const WIZARDCONNECT_RELAY_VISIBILITY_REPLACEMENT =
  "maxReconnectAttempts:e.maxReconnectAttempts,enableVisibilityHandling:!1";

const reconnectOptionPattern =
  /(maxReconnectAttempts\s*:\s*[$A-Z_a-z][$\w]*\.maxReconnectAttempts)(\s*)(,?)/g;

export function hasWizardConnectVisibilityTarget(code: string): boolean {
  return new RegExp(reconnectOptionPattern.source).test(code);
}

export function patchWizardConnectVisibilityHandling(code: string): string {
  const matches = Array.from(code.matchAll(reconnectOptionPattern));
  if (matches.length !== 1) {
    throw new Error(
      "Expected exactly one WizardConnect initiateDappRelay reconnect-options call; found " +
      matches.length + ". Review the WizardConnect SDK before updating this patch.",
    );
  }
  return code.replace(
    reconnectOptionPattern,
    (_match, option: string, whitespace: string, trailingComma: string) =>
      option + ",enableVisibilityHandling:!1" + whitespace + trailingComma,
  );
}
