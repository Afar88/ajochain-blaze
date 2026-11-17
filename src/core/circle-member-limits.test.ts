import { describe, expect, it } from "vitest";
import { validateClassicCircle } from "./classic-bch";
import { validateV2FeeCircleDraft } from "./v2-fee-bch";
import { planPusdMainnetCircleGenesis } from "./pusd-mainnet-circle";

describe("circle creation member limits", () => {
  for (const memberCount of [1, 6]) {
    const members = Array.from({ length: memberCount }, (_, index) => "not-an-address-" + index);

    it("rejects " + memberCount + " members in Classic BCH, V2 BCH and PUSD creation", async () => {
      expect(() => validateClassicCircle({
        version: 1,
        name: "Ajo circle",
        network: "chipnet",
        members,
        contribution: 200_000n,
        maxFee: 10_000n,
      })).toThrow(/2–5 members/);

      expect(() => validateV2FeeCircleDraft({
        version: 2,
        covenant: "fee-v3-auto-reserve-guarded",
        name: "Ajo fee circle",
        network: "chipnet",
        members,
        contribution: 200_000n,
        maxFee: 10_000n,
        initiator: "not-an-address",
        treasury: "not-an-address",
      })).toThrow(/2–5 members/);

      await expect(planPusdMainnetCircleGenesis({
        name: "Ajo PUSD circle",
        members,
        contribution: 10_000n,
        maxFee: 20_000n,
      }, "not-an-address")).rejects.toThrow(/2–5 members/);
    });
  }
});
