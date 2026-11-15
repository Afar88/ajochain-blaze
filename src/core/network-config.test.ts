import { describe, expect, it } from "vitest";
import { getDefaultNetwork } from "./network-config";

describe("default network selection", () => {
  it("opens production builds on BCH Mainnet inspection mode", () => {
    expect(getDefaultNetwork(true)).toBe("mainnet");
  });

  it("keeps local and development builds on Chipnet", () => {
    expect(getDefaultNetwork(false)).toBe("chipnet");
  });
});
