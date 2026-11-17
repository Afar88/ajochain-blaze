import { describe, expect, it } from "vitest";
import {
  CHIPNET_ELECTRUM_ENDPOINTS,
  CHIPNET_ELECTRUM_PROTOCOL_VERSION,
  CHIPNET_ELECTRUM_SOCKET_OPTIONS,
  CHIPNET_ELECTRUM_TIMEOUT_MS,
} from "./chipnet-electrum-config";

describe("Chipnet Electrum browser transport", () => {
  it("uses Electrum 1.5.0 for CashScript token-aware chain reads", () => {
    expect(CHIPNET_ELECTRUM_PROTOCOL_VERSION).toBe("1.5.0");
  });

  it("uses the correctly named socket timeout and keeps browser-tab switching from closing the socket", () => {
    expect(CHIPNET_ELECTRUM_SOCKET_OPTIONS).toEqual({
      encrypted: true,
      timeoutInMilliSeconds: CHIPNET_ELECTRUM_TIMEOUT_MS,
      enforceConsistentBrowserBehavior: false,
    });
    expect(CHIPNET_ELECTRUM_SOCKET_OPTIONS).not.toHaveProperty("timeout");
    expect(CHIPNET_ELECTRUM_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });

  it("uses the probed secure Chipnet endpoints and keeps the standard WSS port first", () => {
    expect(CHIPNET_ELECTRUM_ENDPOINTS[0]).toEqual([
      "electrum-chipnet.optnlabs.com",
      443,
    ]);
    expect(CHIPNET_ELECTRUM_ENDPOINTS).toEqual([
      ["electrum-chipnet.optnlabs.com", 443],
      ["chipnet.bch.ninja", 50004],
      ["cbch.loping.net", 62104],
    ]);
    for (const [host, port] of CHIPNET_ELECTRUM_ENDPOINTS) {
      expect(host).toMatch(/^[a-z0-9.-]+$/i);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });
});
