import { describe, expect, it } from "vitest";
import {
  createWalletScanScheduler, readWalletBalanceCache, runTwoStepWalletScan, selectPusdScanAddresses,
  settleWithConcurrency, sumSettledPusd, walletBalanceCacheKey, writeWalletBalanceCache,
} from "./wallet-balance-scan";

const choice = (address: string, sats: string, hasHistory: boolean) => ({
  address, confirmedSatoshis: sats, unconfirmedSatoshis: "0", hasHistory, hasPendingHistory: false,
});

describe("wallet balance scan", () => {
  it("clears Updating after the BCH step even when PUSD is slow", async () => {
    const events: string[] = [];
    let releasePusd!: () => void;
    const pusdGate = new Promise<void>((resolve) => { releasePusd = resolve; });
    const done = runTwoStepWalletScan({
      scanBch: async () => 5,
      onBchDone: () => events.push("bch-done"),
      scanPusd: async () => { await pusdGate; return 7; },
      onPusdDone: () => events.push("pusd-done"),
      onPusdError: () => events.push("pusd-error"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["bch-done"]);
    releasePusd();
    await done;
    expect(events).toEqual(["bch-done", "pusd-done"]);
  });

  it("does not cancel a running scan when a refresh is requested, and runs once more after", async () => {
    const scheduler = createWalletScanScheduler();
    const finished: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    expect(scheduler.request(async () => { await firstGate; finished.push(1); })).toBe(true);
    expect(scheduler.request(async () => { finished.push(2); })).toBe(false);
    expect(scheduler.request(async () => { finished.push(3); })).toBe(false);
    expect(scheduler.running).toBe(true);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // First scan completed; exactly one queued follow-up ran (the latest one).
    expect(finished).toEqual([1, 3]);
    expect(scheduler.running).toBe(false);
  });

  it("keeps the PUSD total of addresses that loaded when one fails", async () => {
    const results = await settleWithConcurrency(["a", "b", "c"], 6, async (address) => {
      if (address === "b") throw new Error("server busy");
      return { utxos: [{ txid: "tx-" + address, vout: 0, token: { amount: 150n } }] };
    });
    const summed = sumSettledPusd(results);
    expect(summed.total).toBe(300n);
    expect(summed.failed).toEqual(["b"]);
    expect(summed.succeeded).toBe(2);
    expect(summed.byAddress).toEqual({ a: "150", c: "150" });
  });

  it("counts a coin once even if two lookups return it", () => {
    const summed = sumSettledPusd([
      { item: "a", ok: true, value: { utxos: [{ txid: "AA", vout: 1, token: { amount: 10n } }] } },
      { item: "b", ok: true, value: { utxos: [{ txid: "aa", vout: 1, token: { amount: 10n } }] } },
    ]);
    expect(summed.total).toBe(10n);
  });

  it("only asks for PUSD on addresses with history plus selected and current", () => {
    const addresses = selectPusdScanAddresses([
      choice("bitcoincash:used", "0", true),
      choice("bitcoincash:funded", "1000", false),
      choice("bitcoincash:empty1", "0", false),
      choice("bitcoincash:empty2", "0", false),
    ], ["bitcoincash:selected", "bitcoincash:USED", null]);
    expect(addresses).toEqual(["bitcoincash:selected", "bitcoincash:USED", "bitcoincash:funded"]);
  });

  it("caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    await settleWithConcurrency(Array.from({ length: 20 }, (_, i) => String(i)), 6, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("returns saved balances before any network call", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const key = walletBalanceCacheKey("mainnet", "bitcoincash:QFIRST");
    expect(readWalletBalanceCache(storage, key)).toBeNull();
    writeWalletBalanceCache(storage, key, {
      savedAt: 123, choices: [choice("bitcoincash:x", "5000", true)], pusdTotal: "250", pusdByAddress: { "bitcoincash:x": "250" },
    });
    const cached = readWalletBalanceCache(storage, walletBalanceCacheKey("mainnet", "bitcoincash:qfirst"));
    expect(cached?.savedAt).toBe(123);
    expect(cached?.pusdTotal).toBe("250");
    expect(cached?.choices).toHaveLength(1);
  });

  it("ignores a corrupted cache", () => {
    const storage = { getItem: () => "{not json" };
    expect(readWalletBalanceCache(storage, "k")).toBeNull();
    const badTotal = { getItem: () => JSON.stringify({ savedAt: 1, choices: [], pusdTotal: "-5" }) };
    expect(readWalletBalanceCache(badTotal, "k")).toBeNull();
  });
});
