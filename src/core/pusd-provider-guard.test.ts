import { describe, expect, it } from "vitest";
import { PUSD_ASSET } from "./assets";
import { validatePusdProviderSnapshot, type PusdProviderSnapshot } from "./pusd-provider-guard";

const snapshot: PusdProviderSnapshot = {
  providerId: "test-provider",
  network: "mainnet",
  address: "bitcoincash:owner",
  category: PUSD_ASSET.categoryId,
  tipHeight: 900000,
  tipHash: "a".repeat(64),
  observedAtMs: 10000,
  paginationComplete: true,
  utxos: [{
    txid: "b".repeat(64), vout: 0, satoshis: 1000n,
    token: { category: PUSD_ASSET.categoryId, amount: 500n },
  }],
};
const policy = { expectedAddress: snapshot.address, nowMs: 11000, maxAgeMs: 5000, minTipHeight: 899999 };

describe("PUSD provider snapshot guard", () => {
  it("accepts a complete fresh mainnet snapshot for the expected address/category", () => {
    expect(validatePusdProviderSnapshot(snapshot, policy)).toHaveLength(1);
  });
  it("rejects wrong network, address, and category", () => {
    expect(() => validatePusdProviderSnapshot({ ...snapshot, network: "chipnet" as "mainnet" }, policy)).toThrow(/wrong network/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, address: "other" }, policy)).toThrow(/different address/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, category: "0".repeat(64) }, policy)).toThrow(/wrong token category/);
  });
  it("rejects stale snapshots, old tips, and incomplete pagination", () => {
    expect(() => validatePusdProviderSnapshot({ ...snapshot, observedAtMs: 1 }, policy)).toThrow(/stale/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, tipHeight: 1 }, policy)).toThrow(/behind/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, paginationComplete: false }, policy)).toThrow(/incomplete/);
  });
  it("rejects duplicate, malformed, NFT, and non-PUSD UTXOs", () => {
    expect(() => validatePusdProviderSnapshot({ ...snapshot, utxos: [snapshot.utxos[0], snapshot.utxos[0]] }, policy)).toThrow(/duplicate/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, utxos: [{ ...snapshot.utxos[0], token: { category: "0".repeat(64), amount: 1n } }] }, policy)).toThrow(/unexpected token category/);
    expect(() => validatePusdProviderSnapshot({ ...snapshot, utxos: [{ ...snapshot.utxos[0], token: { ...snapshot.utxos[0].token!, nft: { capability: "none" as const, commitment: "" } } }] }, policy)).toThrow(/NFT-bearing/);
  });
});
