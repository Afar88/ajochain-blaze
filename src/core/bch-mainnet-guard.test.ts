import { describe, expect, it } from "vitest";
import {
  assertBchTransactionBroadcastAllowed,
  BCH_MAINNET_CIRCLE_SEND_ENABLED,
  BCH_MAINNET_OPERATIONS_ENABLED,
} from "./bch-mainnet-guard";

describe("BCH Mainnet transaction gate", () => {
  it("remains closed until the Classic covenant and wallet path are independently reviewed", () => {
    expect(BCH_MAINNET_OPERATIONS_ENABLED).toBe(false);
    expect(() => assertBchTransactionBroadcastAllowed("mainnet"))
      .toThrow(/BCH Mainnet broadcasting is still locked/);
  });

  it("keeps the V3 Mainnet circle send path locked pending release approval", () => {
    expect(BCH_MAINNET_CIRCLE_SEND_ENABLED).toBe(false);
  });

  it("continues to allow Chipnet test transactions", () => {
    expect(() => assertBchTransactionBroadcastAllowed("chipnet")).not.toThrow();
  });
});
