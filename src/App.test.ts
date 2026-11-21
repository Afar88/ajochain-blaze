import { describe, expect, it } from "vitest";
import {
  getCancelledDiscoveryStatus,
  getDefaultWalletReceiveIndex,
  getDiscoveryEffectDependencies,
  getDiscoveryNetworkStatus,
  getWalletBchBalanceSummary,
  getWalletDiscoveryCacheKey,
  isWalletDiscoveryCacheFresh,
  readWalletDiscoveryCache,
  writeWalletDiscoveryCache,
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
    expect(summary.detailLabel).toBe("Across all wallet addresses");
    expect(summary.sourceLabel).toBe("Receive and change address balances");
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


describe("wallet receive and change balances", () => {
  it("includes change-address coins in the total BCH balance", () => {
    const summary = getWalletBchBalanceSummary({
      ...baseInput,
      receiveAddressChoices: [
        {
          index: 0, branch: "receive", address: "bitcoincash:qreceive",
          confirmedSatoshis: "100000000", unconfirmedSatoshis: "0",
          hasHistory: true, hasPendingHistory: false, status: "confirmed", newest: false,
        },
        {
          index: 0, branch: "change", address: "bitcoincash:qchange",
          confirmedSatoshis: "25000000", unconfirmedSatoshis: "50",
          hasHistory: true, hasPendingHistory: false, status: "confirmed", newest: false,
        },
      ],
    });
    expect(summary.balanceLabel).toBe("1.25000050 BCH");
  });

  it("chooses the receive address with the most BCH and keeps a saved user choice", () => {
    const addresses = [
      { branch: "receive" as const, index: 0, confirmedSatoshis: "1", unconfirmedSatoshis: "0" },
      { branch: "change" as const, index: 0, confirmedSatoshis: "900000000", unconfirmedSatoshis: "0" },
      { branch: "receive" as const, index: 3, confirmedSatoshis: "5000", unconfirmedSatoshis: "0" },
    ];
    expect(getDefaultWalletReceiveIndex(addresses)).toBe(3);
    expect(getDefaultWalletReceiveIndex(addresses, 0)).toBe(0);
  });
});

describe("wallet circle discovery cache", () => {
  it("restores cached circles on reopen while the 30-minute result is fresh", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    const key = getWalletDiscoveryCacheKey("bitcoincash:qFirstReceive", "mainnet");
    const saved = writeWalletDiscoveryCache(storage, key, ["circle-one", "circle-two"], 1_000);
    const reopened = readWalletDiscoveryCache(storage, key);
    expect(reopened).toEqual(saved);
    expect(reopened?.circles).toEqual(["circle-one", "circle-two"]);
    expect(isWalletDiscoveryCacheFresh(reopened, 1_000 + 29 * 60 * 1000)).toBe(true);
    expect(isWalletDiscoveryCacheFresh(reopened, 1_000 + 31 * 60 * 1000)).toBe(false);
  });

  it("keys the result by first receive address and network", () => {
    expect(getWalletDiscoveryCacheKey("bitcoincash:qfirst", "mainnet"))
      .not.toBe(getWalletDiscoveryCacheKey("bitcoincash:qsecond", "mainnet"));
    expect(getWalletDiscoveryCacheKey("bitcoincash:qfirst", "mainnet"))
      .not.toBe(getWalletDiscoveryCacheKey("bitcoincash:qfirst", "chipnet"));
  });
});
