import { describe, expect, it } from "vitest";
import {
  getCancelledDiscoveryStatus,
  getDiscoveryEffectDependencies,
  getDiscoveryNetworkStatus,
  getWalletAddressChoiceKey,
  getDefaultReceiveAddressIndex,
  getDefaultWalletDisplayAddressKey,
  getWalletBchBalanceSummary,
  readWalletDiscoveryCache,
  shouldScanWalletDiscovery,
  writeWalletDiscoveryCache,
} from "./App";

describe("App wallet discovery lifecycle", () => {
  it("does not key discovery on receive activity array or selected receive index changes", () => {
    const sessionIdentity = "selene-session-1";
    const walletState = "connected" as const;
    const addressSetRevision = 8;
    const discoveryRun = 0;

    const beforeChoices = [{ branch: "receive" as const, index: 0, address: "bitcoincash:qfirst", confirmedSatoshis: "5" }];
    const afterChoices = [{ branch: "receive" as const, index: 1, address: "bitcoincash:qsecond", confirmedSatoshis: "12" }];
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
          branch: "receive", index: 0, address: "bitcoincash:qone",
          confirmedSatoshis: "100000000", unconfirmedSatoshis: "25",
          hasHistory: true, hasPendingHistory: false, status: "confirmed", newest: false,
        },
        {
          branch: "receive", index: 1, address: "bitcoincash:qtwo",
          confirmedSatoshis: "2", unconfirmedSatoshis: "3",
          hasHistory: true, hasPendingHistory: true, status: "pending", newest: true,
        },
      ],
    });
    expect(summary.balanceLabel).toBe("1.00000030 BCH");
    expect(summary.detailLabel).toBe("Across all wallet addresses");
    expect(summary.sourceLabel).toBe("All receive and change addresses");
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
    expect(summary.sourceLabel).toBe("No wallet scan yet");
  });
});


describe("wallet-wide address and discovery cache helpers", () => {
  function createStorage() {
    const values = new Map<string, string>();
    return {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    };
  }

  it("counts BCH held on both receive and change addresses", () => {
    const summary = getWalletBchBalanceSummary({
      network: "mainnet",
      connected: true,
      currentBchBalanceScan: null,
      receiveAddressScanLoading: false,
      receiveAddressChoices: [
        {
          branch: "receive", index: 0, address: "bitcoincash:qreceive",
          confirmedSatoshis: "100000000", unconfirmedSatoshis: "0",
          hasHistory: true, hasPendingHistory: false, status: "confirmed", newest: false,
        },
        {
          branch: "change", index: 0, address: "bitcoincash:qchange",
          confirmedSatoshis: "50000000", unconfirmedSatoshis: "30",
          hasHistory: true, hasPendingHistory: true, status: "pending", newest: false,
        },
      ],
    });
    expect(summary.balanceLabel).toBe("1.50000030 BCH");
  });

  it("keeps the highest-funded wallet address as the display default while receive selection stays on a receive path", () => {
    const choices = [
      { branch: "receive" as const, index: 0, address: "bitcoincash:qreceive", confirmedSatoshis: "100", unconfirmedSatoshis: "0", hasHistory: true, hasPendingHistory: false, status: "confirmed" as const, newest: false },
      { branch: "change" as const, index: 0, address: "bitcoincash:qchange", confirmedSatoshis: "900", unconfirmedSatoshis: "0", hasHistory: true, hasPendingHistory: false, status: "confirmed" as const, newest: false },
      { branch: "receive" as const, index: 1, address: "bitcoincash:qempty", confirmedSatoshis: "0", unconfirmedSatoshis: "0", hasHistory: false, hasPendingHistory: false, status: "unused" as const, newest: true },
    ];
    expect(getDefaultWalletDisplayAddressKey(choices)).toBe("change:0");
    expect(getDefaultReceiveAddressIndex(choices)).toBe(0);
    expect(getWalletAddressChoiceKey(choices[1])).toBe("change:0");
  });

  it("shows cached circles immediately after reopening and scans only after 30 minutes or a manual check", () => {
    const storage = createStorage();
    const now = 1_800_000_000_000;
    writeWalletDiscoveryCache(storage, "bitcoincash:qfirst", "mainnet", ["circle-a", "circle-b"], now);
    const firstOpen = readWalletDiscoveryCache(storage, "bitcoincash:qfirst", "mainnet");
    const reopened = readWalletDiscoveryCache(storage, "bitcoincash:qfirst", "mainnet");
    expect(firstOpen?.circles).toEqual(["circle-a", "circle-b"]);
    expect(reopened?.circles).toEqual(["circle-a", "circle-b"]);
    expect(shouldScanWalletDiscovery(reopened, false, now + 29 * 60_000)).toBe(false);
    expect(shouldScanWalletDiscovery(reopened, false, now + 31 * 60_000)).toBe(true);
    expect(shouldScanWalletDiscovery(reopened, true, now + 1_000)).toBe(true);
  });
});
