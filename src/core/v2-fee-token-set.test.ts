import { describe, expect, it } from "vitest";
import type { SpendableUtxo } from "cashscript";
import { describeV2FeeTokenSetMismatch } from "./v2-fee-bch";

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
