/**
 * Browser-compatible, secure WebSocket endpoints for BCH Chipnet.
 * The list is ordered by the 2026-11-17 browser RPC probe.
 */
export const CHIPNET_ELECTRUM_ENDPOINTS = [
  ["electrum-chipnet.optnlabs.com", 443],
  ["chipnet.bch.ninja", 50004],
  ["cbch.loping.net", 62104],
] as const;

export const CHIPNET_ELECTRUM_PROTOCOL_VERSION = "1.5.0";
export const CHIPNET_ELECTRUM_TIMEOUT_MS = 12_000;

/**
 * Electrum 1.5.0 is required by the CashScript provider's token-aware reads.
 * Disable page-visibility socket shutdown because users switch to Selene /
 * WizardConnect and return to the app while requests or subscriptions are live.
 * This is intentionally browser-only; do not reuse this option in Node.js.
 */
export const CHIPNET_ELECTRUM_SOCKET_OPTIONS = {
  encrypted: true,
  timeoutInMilliSeconds: CHIPNET_ELECTRUM_TIMEOUT_MS,
  enforceConsistentBrowserBehavior: false,
} as const;
