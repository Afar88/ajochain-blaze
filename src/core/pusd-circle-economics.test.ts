import { describe, expect, it } from "vitest";
import { calculatePusdCircleEconomics } from "./pusd-circle-economics";

describe("PUSD circle covenant economics", () => {
  it("calculates the separate 1% treasury fee in integer base units", () => {
    const result = calculatePusdCircleEconomics(5, 10_000n);
    expect(result.grossPot).toBe(50_000n);
    expect(result.projectFee).toBe(500n);
    expect(result.firstPayoutReserve).toBe(10_000n);
    expect(result.firstRecipientPayout).toBe(39_500n);
    expect(result.finalRecipientPayout).toBe(49_500n);
  });

  it("floors the fee without using floating-point arithmetic", () => {
    const result = calculatePusdCircleEconomics(2, 101n);
    expect(result.grossPot).toBe(202n);
    expect(result.projectFee).toBe(2n);
    expect(result.firstRecipientPayout).toBe(99n);
  });

  it("rejects tiny pots that cannot pay at least 0.01 PUSD as the 1% fee", () => {
    expect(() => calculatePusdCircleEconomics(2, 49n)).toThrow(/one raw PUSD unit/);
  });

  it("enforces supported member counts and CashTokens amount bounds", () => {
    expect(() => calculatePusdCircleEconomics(1, 100n)).toThrow(/2 and 5/);
    expect(() => calculatePusdCircleEconomics(2, 0n)).toThrow(/outside/);
  });
});
