import { describe, expect, it } from "vitest";
import { isAddressForNetwork } from "./network";

describe("network address prefix guard", () => {
  it("accepts a non-empty mainnet CashAddress with the mainnet prefix", () => {
    expect(isAddressForNetwork("bitcoincash:qexample", "mainnet")).toBe(true);
    expect(isAddressForNetwork("BITCOINCASH:qexample", "mainnet")).toBe(true);
  });

  it("accepts a non-empty Chipnet CashAddress with the test prefix", () => {
    expect(isAddressForNetwork("bchtest:qexample", "chipnet")).toBe(true);
  });

  it("rejects addresses from the other network", () => {
    expect(isAddressForNetwork("bchtest:qexample", "mainnet")).toBe(false);
    expect(isAddressForNetwork("bitcoincash:qexample", "chipnet")).toBe(false);
  });

  it("rejects bare prefixes, prefix lookalikes and empty payloads", () => {
    for (const address of ["bitcoincash", "bitcoincashgarbage", "bitcoincash:", " bchtest: "]) {
      expect(isAddressForNetwork(address, "mainnet")).toBe(false);
    }
  });
});
