import { describe, expect, it } from "vitest";
import { encodeCashAddress } from "@bitauth/libauth";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "./project-treasury";
import {
  createBchMainnetCircleDraft,
} from "./bch-mainnet-circle";

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

  it("does not permit the Chipnet treasury to be substituted for Mainnet", () => {
    // The public constructor always pins the shared address; callers cannot
    // override this field when creating the supported Mainnet draft type.
    expect(createBchMainnetCircleDraft(base).treasury)
      .toBe("bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q");
  });
});
