import { describe, expect, it } from "vitest";
import { encodeCashAddress } from "@bitauth/libauth";
import {
  decodeV2Circle,
  encodeV2Circle,
  validateV2Circle,
  v2CreditFromCommitment,
  v2ReceiptCommitment,
} from "./v2-bch";

function chipnetAddress(byte: number) {
  const result = encodeCashAddress({
    prefix: "bchtest",
    type: "p2pkh",
    payload: new Uint8Array(20).fill(byte),
  });
  if (typeof result === "string") throw new Error(result);
  return result.address;
}

const draft = {
  version: 2 as const,
  name: "V2 Family Ajo",
  network: "chipnet" as const,
  members: [chipnetAddress(3), chipnetAddress(4)],
  contribution: 100_000n,
  maxFee: 10_000n,
};

describe("V2 member receipt encoding", () => {
  it("round-trips exact 64-bit credit values", () => {
    for (const credit of [0n, 1n, 100_000n, 0x7fffffffffffffffn]) {
      expect(v2CreditFromCommitment(v2ReceiptCommitment(2, credit))).toBe(credit);
    }
  });

  it("rejects invalid member indexes and out-of-range credit", () => {
    expect(() => v2ReceiptCommitment(-1, 1n)).toThrow(/Invalid V2 member receipt/);
    expect(() => v2ReceiptCommitment(5, 1n)).toThrow(/Invalid V2 member receipt/);
    expect(() => v2ReceiptCommitment(0, 0x8000000000000000n)).toThrow(/Invalid V2 member receipt/);
    expect(() => v2CreditFromCommitment("53000000000000000000")).toThrow(/Invalid V2 member receipt/);
  });
});

describe("V2 circle release boundary", () => {
  it("accepts a valid 2-member Chipnet draft", () => {
    expect(() => validateV2Circle(draft)).not.toThrow();
  });

  it("round-trips a V2 invite link with exact amounts and member order", () => {
    const params = { ...draft, stateCategory: "cd".repeat(32) };
    const restored = decodeV2Circle(encodeV2Circle(params));
    expect(restored.members).toEqual(params.members);
    expect(restored.contribution).toBe(params.contribution);
    expect(restored.maxFee).toBe(params.maxFee);
    expect(restored.stateCategory).toBe(params.stateCategory);
  });

  it("rejects Mainnet before a V2 plan can be built", () => {
    expect(() => validateV2Circle({ ...draft, network: "mainnet" as "chipnet" }))
      .toThrow(/Chipnet-only/);
  });

  it("rejects duplicate member addresses", () => {
    expect(() => validateV2Circle({ ...draft, members: [draft.members[0], draft.members[0]] }))
      .toThrow(/unique Chipnet BCH address/);
  });

  it("requires the payout fee to preserve the recipient dust floor", () => {
    expect(() => validateV2Circle({ ...draft, maxFee: 199_001n }))
      .toThrow(/leave at least 1,000 sats/);
  });
});
