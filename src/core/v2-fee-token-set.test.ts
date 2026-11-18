import { describe, expect, it } from "vitest";
import type { Contract, SpendableUtxo } from "cashscript";
import { vi } from "vitest";
import { describeV2FeeTokenSetMismatch, getV2FeeCircleTokenUtxos } from "./v2-fee-bch";

const CATEGORY = "ab".repeat(32);
const ADDRESS = "bchtest:pqexamplecontractaddress";

function utxo(category: string): SpendableUtxo {
  return {
    txid: "11".repeat(32),
    vout: 0,
    satoshis: 1000n,
    token: { category, amount: 0n },
  } as SpendableUtxo;
}

describe("V2 circle token-set diagnostics", () => {
  it("explains an empty contract address without claiming another circle is lost", () => {
    const message = describeV2FeeTokenSetMismatch([], CATEGORY, 3, "chipnet", ADDRESS);
    expect(message).toContain("No on-chain outputs were found");
    expect(message).toContain(ADDRESS);
    expect(message).toContain(CATEGORY);
    expect(message).toContain("No transaction was sent");
    expect(message).toContain("other circle or contribution is missing");
  });

  it("reports unrelated token categories when the saved record derives the wrong contract", () => {
    const otherCategory = "cd".repeat(32);
    const message = describeV2FeeTokenSetMismatch(
      [utxo(otherCategory)], CATEGORY, 3, "chipnet", ADDRESS,
    );
    expect(message).toContain("does not match the outputs");
    expect(message).toContain(CATEGORY);
    expect(message).toContain(otherCategory);
    expect(message).toContain("Do not recreate the circle");
  });
});

describe("V2 circle CashToken UTXO lookup", () => {
  it("queries the token-aware contract address, not the ordinary BCH address", async () => {
    const tokenAddress = "bchtest:zqtokenawarecontract";
    const ordinaryAddress = "bchtest:pqordinarycontract";
    const getUtxos = vi.fn(async (address: string) => {
      return address === tokenAddress ? [utxo(CATEGORY)] : [];
    });
    const contract = {
      address: ordinaryAddress,
      tokenAddress,
      provider: { getUtxos },
    } as unknown as Contract;

    const result = await getV2FeeCircleTokenUtxos(contract);
    expect(getUtxos).toHaveBeenCalledTimes(1);
    expect(getUtxos).toHaveBeenCalledWith(tokenAddress);
    expect(getUtxos).not.toHaveBeenCalledWith(ordinaryAddress);
    expect(result).toHaveLength(1);
  });
});
