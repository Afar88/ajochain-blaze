import { describe, expect, it } from "vitest";
import type { SpendableUtxo } from "cashscript";
import { selectCashTokensGenesisUtxo } from "./cash-token-genesis";

function coin(vout: number, satoshis: bigint, token = false, txid = "11".repeat(32)) {
  return {
    txid,
    vout,
    satoshis,
    lockingBytecode: "76a914" + "22".repeat(20) + "88ac",
    ...(token ? { token: { category: "33".repeat(32), amount: 1n } } : {}),
  } as SpendableUtxo;
}

describe("CashTokens genesis outpoint selection", () => {
  it("accepts a small non-token vout-0 coin without an arbitrary 3,000-sat floor", () => {
    const smallGenesisCoin = coin(0, 1n);
    expect(selectCashTokensGenesisUtxo([
      coin(1, 2_000_000n),
      smallGenesisCoin,
    ])).toBe(smallGenesisCoin);
  });

  it("ignores token-bearing and nonzero-vout coins", () => {
    expect(selectCashTokensGenesisUtxo([
      coin(0, 50_000n, true),
      coin(1, 2_000_000n),
    ])).toBeUndefined();
  });

  it("prefers the largest eligible non-token vout-0 coin", () => {
    const small = coin(0, 5n, false, "11".repeat(32));
    const large = coin(0, 20_000n, false, "22".repeat(32));
    expect(selectCashTokensGenesisUtxo([small, large])).toBe(large);
  });
});
