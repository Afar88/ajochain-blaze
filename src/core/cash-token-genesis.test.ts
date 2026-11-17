import { describe, expect, it } from "vitest";
import type { SpendableUtxo } from "cashscript";
import {
  calculateGenesisSetupChange,
  CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS,
  CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS,
  selectCashTokensGenesisUtxo,
} from "./cash-token-genesis";

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
  it("accepts a small non-token vout-0 coin without a fixed minimum", () => {
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


describe("CashTokens genesis setup output accounting", () => {
  it("uses only the output, estimated fee, and dust-safe wallet change", () => {
    expect(CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS).toBe(1_000n);
    expect(CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS).toBe(546n);
    expect(calculateGenesisSetupChange(2_046n, 500n)).toBe(546n);
    expect(calculateGenesisSetupChange(2_045n, 500n)).toBeUndefined();
  });

  it("does not impose an additional reserve for the follow-up transaction", () => {
    expect(calculateGenesisSetupChange(2_047n, 500n)).toBe(547n);
    expect(calculateGenesisSetupChange(2_045n, 500n)).toBeUndefined();
  });

  it("rejects impossible or negative setup accounting", () => {
    expect(calculateGenesisSetupChange(1_545n, 0n)).toBeUndefined();
    expect(calculateGenesisSetupChange(-1n, 0n)).toBeUndefined();
    expect(calculateGenesisSetupChange(2_000n, -1n)).toBeUndefined();
  });
});
