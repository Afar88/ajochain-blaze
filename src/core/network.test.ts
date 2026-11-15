import { describe, expect, it } from "vitest";
import { isAddressForNetwork } from "./network";

describe("network CashAddress validation", () => {
  const mainnetAddress = "bitcoincash:qq2azmyyv6dtgczexyalqar70q036yund54qgw0wg6";
  const chipnetAddress = "bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x";

  it("accepts checksummed mainnet CashAddresses", () => {
    expect(isAddressForNetwork(mainnetAddress, "mainnet")).toBe(true);
    expect(isAddressForNetwork(mainnetAddress.toUpperCase(), "mainnet")).toBe(true);
  });

  it("accepts checksummed Chipnet CashAddresses", () => {
    expect(isAddressForNetwork(chipnetAddress, "chipnet")).toBe(true);
  });

  it("rejects addresses from the other network", () => {
    expect(isAddressForNetwork(chipnetAddress, "mainnet")).toBe(false);
    expect(isAddressForNetwork(mainnetAddress, "chipnet")).toBe(false);
  });

  it("rejects fake payloads and altered checksums", () => {
    expect(isAddressForNetwork("bitcoincash:qexample", "mainnet")).toBe(false);
    expect(isAddressForNetwork("bchtest:qexample", "chipnet")).toBe(false);
    expect(isAddressForNetwork(mainnetAddress.slice(0, -1) + "x", "mainnet")).toBe(false);
  });
  it("rejects bare prefixes, prefix lookalikes and empty payloads", () => {
    for (const address of ["bitcoincash", "bitcoincashgarbage", "bitcoincash:", " bchtest: "]) {
      expect(isAddressForNetwork(address, "mainnet")).toBe(false);
    }
  });
});
