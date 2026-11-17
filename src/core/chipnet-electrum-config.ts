/**
 * Browser-compatible, secure WebSocket endpoints for BCH Chipnet.
 * The list is ordered by the 2026-11-17 browser RPC probe.
 */
export const CHIPNET_ELECTRUM_ENDPOINTS = [
  ["electrum-chipnet.optnlabs.com", 443],
  ["chipnet.bch.ninja", 50004],
  ["cbch.loping.net", 62104],
] as const;

export const ELECTRUM_PROTOCOL_VERSION = "1.5.0";
export const ELECTRUM_TIMEOUT_MS = 12_000;

/**
 * Electrum 1.5.0 is required by the CashScript provider's token-aware reads.
 * Disable page-visibility socket shutdown because users switch to Selene /
 * WizardConnect and return to the app while requests or subscriptions are live.
 * This is intentionally browser-only; do not reuse this option in Node.js.
 */
export const ELECTRUM_SOCKET_OPTIONS = {
  encrypted: true,
  timeoutInMilliSeconds: ELECTRUM_TIMEOUT_MS,
  enforceConsistentBrowserBehavior: false,
} as const;

/**
 * A valid user override is preferred, never allowed to remove the known
 * fallback endpoints. Ignore malformed or out-of-range local settings.
 */
export function getChipnetElectrumEndpoints(configured: string | null): Array<[string, number]> {
  const defaults: Array<[string, number]> = CHIPNET_ELECTRUM_ENDPOINTS.map(([host, port]) => [host, port]);
  if (!configured) return defaults;

  const parts = configured.trim().split(":");
  if (parts.length !== 2) return defaults;
  const [host, rawPort] = parts;
  const port = Number(rawPort);
  if (!/^[a-z0-9.-]+$/i.test(host) ||
      !Number.isInteger(port) || port < 1 || port > 65_535) {
    return defaults;
  }

  return [
    [host, port],
    ...defaults.filter(([defaultHost, defaultPort]) =>
      defaultHost !== host || defaultPort !== port
    ),
  ];
}
