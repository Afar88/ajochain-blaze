import { describe, expect, it } from "vitest";
import { toCashTokenAddress } from "./bch-address";

describe("toCashTokenAddress", () => {
  it("shows a plain address in its CashTokens form", () => {
    expect(toCashTokenAddress("bitcoincash:qr0upm68xfzyu0smvmkr47pr04ywktaeturvmetgda"))
      .toBe("bitcoincash:zr0upm68xfzyu0smvmkr47pr04ywktaetuyxg89wjw");
  });
  it("leaves z, contract and invalid input unchanged", () => {
    const z = "bitcoincash:zr0upm68xfzyu0smvmkr47pr04ywktaetuyxg89wjw";
    expect(toCashTokenAddress(z)).toBe(z);
    const p = "bitcoincash:p0chq232z0p58nqazzmltt7yw52te48gm5sqj74gn3e3yma7g44tu7k3rz880";
    expect(toCashTokenAddress(p)).toBe(p);
    expect(toCashTokenAddress("nonsense")).toBe("nonsense");
    expect(toCashTokenAddress(null)).toBe("");
  });
});
