import { describe, expect, it } from "vitest";
import {
  assertPusdMainnetSpendingAllowed,
  PUSD_MAINNET_SPENDING_ENABLED,
} from "./pusd-mainnet-guard";

describe("PUSD mainnet spend kill-switch", () => {
  it("is hard-disabled in this release", () => {
    expect(PUSD_MAINNET_SPENDING_ENABLED).toBe(false);
  });

  it("rejects PUSD mainnet spending", () => {
    expect(() => assertPusdMainnetSpendingAllowed({
      network: "mainnet", asset: "PUSD",
    })).toThrow(/PUSD mainnet spending is disabled/);
  });

  it("does not block read-only or non-PUSD contexts", () => {
    expect(() => assertPusdMainnetSpendingAllowed({
      network: "chipnet", asset: "PUSD",
    })).not.toThrow();
    expect(() => assertPusdMainnetSpendingAllowed({
      network: "mainnet", asset: "BCH",
    })).not.toThrow();
  });
});
