import { describe, expect, it } from "vitest";
import { encodeCashAddress } from "@bitauth/libauth";
import { MockNetworkProvider } from "cashscript";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "./project-treasury";
import { createBchMainnetCircleDraft } from "./bch-mainnet-circle";
import { createV2FeeCircleContract, validateV2FeeCircleDraft, v2FeeCancelWalletInputIndexes, validateV2FeePayoutFeePayerAddress, v2FeeArtifactForCovenant } from "./v2-fee-bch";

function address(seed: number): string {
  const result = encodeCashAddress({
    prefix: "bitcoincash",
    type: "p2pkh",
    payload: new Uint8Array(20).fill(seed),
  });
  if (typeof result === "string") throw new Error(result);
  return result.address;
}

const members = [address(1), address(2)];
const base = {
  version: 2 as const,
  name: "Mainnet Ajo",
  members,
  contribution: 200_000n,
  maxFee: 10_000n,
  initiator: members[0],
};

describe("BCH Mainnet V3 circle adapter", () => {
  it("creates a Mainnet-only V3 draft pinned to the shared BCH/PUSD treasury", () => {
    const draft = createBchMainnetCircleDraft(base);
    expect(draft.network).toBe("mainnet");
    expect(draft.covenant).toBe("fee-v3-auto-reserve-mainnet");
    expect(draft.treasury).toBe(MAINNET_PROJECT_TREASURY_ADDRESS);
  });

  it("keeps a minimum 2-member circle and rejects duplicate member addresses", () => {
    expect(() => createBchMainnetCircleDraft({ ...base, members: [members[0]] }))
      .toThrow(/2–5 members/);
    expect(() => createBchMainnetCircleDraft({ ...base, members: [members[0], members[0]] }))
      .toThrow(/unique BCH address/);
  });

  it("requires at least 0.002 BCH per member and a conservative fee ceiling", () => {
    expect(() => createBchMainnetCircleDraft({ ...base, contribution: 199_999n }))
      .toThrow(/at least 0.002 BCH/);
    expect(() => createBchMainnetCircleDraft({ ...base, maxFee: 1_000n }))
      .toThrow(/conservative transaction estimate/);
  });

  it("rejects a modified Mainnet treasury after draft creation", () => {
    const draft = createBchMainnetCircleDraft(base);
    expect(draft.treasury).toBe(MAINNET_PROJECT_TREASURY_ADDRESS);
    expect(() => validateV2FeeCircleDraft({
      ...draft,
      treasury: "bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3v8v7k",
    })).toThrow(/shared BCH\/PUSD project-fee treasury/);
  });

  it("does not allow the Mainnet covenant variant to be re-labelled as Chipnet", () => {
    const draft = createBchMainnetCircleDraft(base);
    expect(() => validateV2FeeCircleDraft({ ...draft, network: "chipnet" }))
      .toThrow(/Mainnet V3 covenant cannot be used on Chipnet/);
  });

  it("requests the initiator signature for the state NFT, every receipt and fee input on cancellation", () => {
    expect(v2FeeCancelWalletInputIndexes(2)).toEqual([0, 1, 2, 3]);
    expect(v2FeeCancelWalletInputIndexes(5)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(() => v2FeeCancelWalletInputIndexes(1)).toThrow(/2–5 members/);
  });

  it("uses the exact Mainnet V3 compiled artifact with every Mainnet member and the fixed treasury bound into the constructor", () => {
    const provider = new MockNetworkProvider();
    const mainnetMembers = [1, 2, 3, 4, 5].map(address);
    const draft = createBchMainnetCircleDraft({
      ...base,
      members: mainnetMembers,
      initiator: mainnetMembers[0],
    });
    const params = { ...draft, stateCategory: "ab".repeat(32) };
    const contract = createV2FeeCircleContract(params, provider);
    expect(v2FeeArtifactForCovenant("fee-v3-auto-reserve-mainnet").contractName)
      .toBe("AjoCircleV3AutoReserve");
    expect(contract.lockingBytecode.length).toBeGreaterThan(0);
    expect(contract.address).toMatch(/^bchtest:/); // Mock provider address encoding only; constructor PKHs are Mainnet-decoded above.
    const reordered = createV2FeeCircleContract({
      ...params,
      members: [...mainnetMembers].reverse(),
    }, provider);
    expect(reordered.lockingBytecode).not.toEqual(contract.lockingBytecode);
    expect(() => createV2FeeCircleContract({
      ...params,
      treasury: address(77),
    }, provider)).toThrow(/shared BCH\/PUSD project-fee treasury/);
  });

  it("validates payout fee sponsors against the selected Mainnet or Chipnet address prefix", () => {
    const mainnetAddress = address(9);
    const chipnetResult = encodeCashAddress({
      prefix: "bchtest",
      type: "p2pkh",
      payload: new Uint8Array(20).fill(9),
    });
    if (typeof chipnetResult === "string") throw new Error(chipnetResult);
    expect(() => validateV2FeePayoutFeePayerAddress(mainnetAddress, "mainnet")).not.toThrow();
    expect(() => validateV2FeePayoutFeePayerAddress(chipnetResult.address, "mainnet")).toThrow();
    expect(() => validateV2FeePayoutFeePayerAddress(mainnetAddress, "chipnet")).toThrow();
  });
});
