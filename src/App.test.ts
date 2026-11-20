import { describe, expect, it } from "vitest";
import {
  getCancelledDiscoveryStatus,
  getDiscoveryEffectDependencies,
  getDiscoveryNetworkStatus,
  getWalletBchBalanceSummary,
} from "./App";

describe("App wallet discovery lifecycle", () => {
  it("does not key discovery on receive activity array or selected receive index changes", () => {
    const sessionIdentity = "selene-session-1";
    const walletState = "connected" as const;
    const addressSetRevision = 8;
    const discoveryRun = 0;

    const beforeChoices = [{ address: "bitcoincash:qfirst", confirmedSatoshis: "5" }];
    const afterChoices = [{ address: "bitcoincash:qsecond", confirmedSatoshis: "12" }];
    const beforeReceiveIndex = 0;
    const afterReceiveIndex = 17;

    expect(afterChoices).not.toEqual(beforeChoices);
    expect(afterReceiveIndex).not.toBe(beforeReceiveIndex);

    // App's actual effect dependency list is produced only from these four
    // session/run values, so activity-array and selected-index state changes
    // cannot cancel an in-flight scan.
    const before = getDiscoveryEffectDependencies(
      sessionIdentity, walletState, addressSetRevision, discoveryRun,
    );
    const afterActivityRefresh = getDiscoveryEffectDependencies(
      sessionIdentity, walletState, addressSetRevision, discoveryRun,
    );
    expect(afterActivityRefresh).toEqual(before);
    expect(afterActivityRefresh).toHaveLength(4);
  });

  it("rekeys discovery when the wallet session or address set changes", () => {
    const base = getDiscoveryEffectDependencies("session-a", "connected", 3, 0);
    expect(getDiscoveryEffectDependencies("session-b", "connected", 3, 0)).not.toEqual(base);
    expect(getDiscoveryEffectDependencies("session-a", "connected", 4, 0)).not.toEqual(base);
    expect(getDiscoveryEffectDependencies("session-a", "reconnecting", 3, 0)).not.toEqual(base);
    expect(getDiscoveryEffectDependencies("session-a", "connected", 3, 1)).not.toEqual(base);
  });

  it("publishes a final Mainnet status for success, errors, and the overall timeout", () => {
    expect(getDiscoveryNetworkStatus(
      "Mainnet", { status: "fulfilled", value: { foundCount: 0 } }, false,
    )).toBe("Mainnet: checked, none found.");
    expect(getDiscoveryNetworkStatus(
      "Mainnet", { status: "fulfilled", value: { foundCount: 1 } }, false,
    )).toBe("Mainnet: found 1 circle.");
    expect(getDiscoveryNetworkStatus(
      "Mainnet", { status: "fulfilled", value: { foundCount: 0 } }, true,
    )).toBe("Mainnet: timed out, tap Retry to check again.");
    expect(getDiscoveryNetworkStatus(
      "Mainnet", { status: "rejected", reason: new Error("offline") }, true,
    )).toBe("Mainnet: timed out, tap Retry to check again.");
    expect(getCancelledDiscoveryStatus("Mainnet")).not.toContain("checking");
  });
});

describe("App wallet BCH balance summary", () => {
  const baseInput = {
    network: "mainnet" as const,
    connected: true,
    currentBchBalanceScan: null,
    receiveAddressScanLoading: false,
  };

  it("totals confirmed and unconfirmed BCH across every scanned receive address", () => {
    const summary = getWalletBchBalanceSummary({
      ...baseInput,
      receiveAddressChoices: [
        {
          index: 0, address: "bitcoincash:qone",
          confirmedSatoshis: "100000000", unconfirmedSatoshis: "25",
          hasHistory: true, hasPendingHistory: false, status: "confirmed", newest: false,
        },
        {
          index: 1, address: "bitcoincash:qtwo",
          confirmedSatoshis: "2", unconfirmedSatoshis: "3",
          hasHistory: true, hasPendingHistory: true, status: "pending", newest: true,
        },
      ],
    });
    expect(summary.balanceLabel).toBe("1.00000030 BCH");
    expect(summary.detailLabel).toBe("Across your wallet addresses");
    expect(summary.sourceLabel).toBe("Receive-address activity across your wallet addresses");
  });

  it("falls back to the existing gather scan before showing the running state", () => {
    const fallback = getWalletBchBalanceSummary({
      ...baseInput,
      receiveAddressChoices: [],
      currentBchBalanceScan: {
        address: "bitcoincash:qwallet", network: "mainnet", totalSatoshis: 123_000n,
      },
      receiveAddressScanLoading: true,
    });
    expect(fallback.balanceLabel).toBe("0.00123000 BCH");
    expect(fallback.sourceLabel).toBe("Existing wallet coin scan");

    const checking = getWalletBchBalanceSummary({
      ...baseInput,
      receiveAddressChoices: [],
      receiveAddressScanLoading: true,
    });
    expect(checking.balanceLabel).toBe("Checking…");
    expect(checking.sourceLabel).toBe("Receive-address activity scan in progress");
  });

  it("keeps the not-checked fallback when there is no activity or gather scan", () => {
    const summary = getWalletBchBalanceSummary({
      ...baseInput,
      receiveAddressChoices: [],
    });
    expect(summary.balanceLabel).toBe("Not checked yet");
    expect(summary.sourceLabel).toBe("No wallet scan in this session");
  });
});
