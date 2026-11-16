import { describe, expect, it } from "vitest";
import { PUSD_ASSET } from "./assets";
import { assertPusdCategory, planPusdInputs, type AuthenticatedPusdUtxo } from "./pusd-utxo";

const txid = (digit: string) => digit.repeat(64);
const utxo = (digit: string, amount: bigint, extra: Partial<AuthenticatedPusdUtxo> = {}): AuthenticatedPusdUtxo => ({
  txid: txid(digit),
  vout: 0,
  satoshis: 1000n,
  token: { category: PUSD_ASSET.categoryId, amount },
  lockingBytecode: "76a914" + "11".repeat(20) + "88ac",
  provenance: {
    rawTransactionVerified: true,
    txid: txid(digit),
    vout: 0,
    unspentChecked: true,
  },
  ...extra,
});

describe("PUSD UTXO selection", () => {
  it("selects only exact PUSD category UTXOs and computes integer change", () => {
    const plan = planPusdInputs([
      utxo("a", 400n),
      utxo("b", 700n),
      { ...utxo("c", 5000n), token: { category: "0".repeat(64), amount: 5000n } },
    ], 1000n);

    expect(plan.inputs.map((x) => x.token?.amount)).toEqual([400n, 700n]);
    expect(plan.totalTokenAmount).toBe(1100n);
    expect(plan.tokenChange).toBe(100n);
  });

  it("rejects PUSD UTXOs carrying NFTs", () => {
    expect(() => planPusdInputs([
      utxo("a", 2000n, { token: { category: PUSD_ASSET.categoryId, amount: 2000n, nft: { capability: "none", commitment: "01" } } }),
    ], 1000n)).toThrow("contains an NFT");
  });

  it("rejects duplicate outpoints instead of double counting", () => {
    const first = utxo("a", 600n);
    expect(() => planPusdInputs([first, first], 1000n)).toThrow("Duplicate UTXO outpoint");
  });

  it("rejects malformed outpoints and invalid amounts", () => {
    expect(() => planPusdInputs([{ ...utxo("a", 1000n), txid: "bad" }], 100n)).toThrow("invalid outpoint");
    expect(() => planPusdInputs([utxo("a", 0n)], 100n)).toThrow("invalid fungible token amount");
    expect(() => planPusdInputs([utxo("a", 1000n)], 0n)).toThrow("outside the CashTokens");
  });

  it("fails closed when verified PUSD balance is insufficient", () => {
    expect(() => planPusdInputs([utxo("a", 500n)], 501n)).toThrow("Insufficient verified PUSD balance");
  });

  it("asserts the issuer category exactly", () => {
    expect(() => assertPusdCategory(PUSD_ASSET.categoryId)).not.toThrow();
    expect(() => assertPusdCategory("0".repeat(64))).toThrow("Expected ParyonUSD");
  });
});
