import { describe, expect, it } from "vitest";
import { binToHex, decodeCashAddress } from "@bitauth/libauth";
import {
  CHIPNET_PROJECT_TREASURY_ADDRESS,
  MAINNET_PROJECT_TREASURY_ADDRESS,
  MAINNET_PROJECT_TREASURY_LOCKING_BYTECODE,
  MAINNET_PROJECT_TREASURY_PKH_HEX,
  getMainnetProjectTreasuryPkh,
} from "./project-treasury";

describe("shared AjoChain project-fee destinations", () => {
  it("uses the supplied token-aware P2PKH CashAddress for Mainnet", () => {
    const decoded = decodeCashAddress(MAINNET_PROJECT_TREASURY_ADDRESS);
    expect(typeof decoded).not.toBe("string");
    if (typeof decoded === "string") throw new Error(decoded);
    expect(decoded.prefix).toBe("bitcoincash");
    expect(String(decoded.type).toLowerCase()).toBe("p2pkhwithtokens");
    expect(binToHex(decoded.payload)).toBe(MAINNET_PROJECT_TREASURY_PKH_HEX);
    expect(getMainnetProjectTreasuryPkh()).toEqual(decoded.payload);
    expect(MAINNET_PROJECT_TREASURY_LOCKING_BYTECODE).toBe(
      "76a914" + MAINNET_PROJECT_TREASURY_PKH_HEX + "88ac",
    );
  });

  it("keeps the existing Chipnet-only project treasury separate", () => {
    expect(CHIPNET_PROJECT_TREASURY_ADDRESS).toMatch(/^bchtest:/);
    expect(MAINNET_PROJECT_TREASURY_ADDRESS).toMatch(/^bitcoincash:/);
  });
});
