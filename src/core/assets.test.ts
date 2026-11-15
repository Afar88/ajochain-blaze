import { describe, expect, it } from "vitest";
import {
  CASH_TOKEN_MAX_AMOUNT,
  PUSD_ASSET,
  formatAssetAmount,
  isAssetAvailableOnNetwork,
  isPusdCategoryId,
  parseAssetAmount,
} from "./assets";

describe("ParyonUSD CashToken metadata and amount units", () => {
  it("pins the issuer-published mainnet category and 2 decimals", () => {
    expect(PUSD_ASSET.categoryId).toBe("2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544");
    expect(PUSD_ASSET.decimals).toBe(2);
    expect(PUSD_ASSET.network).toBe("mainnet");
  });

  it("parses PUSD exactly without floating point", () => {
    expect(parseAssetAmount("PUSD", "12")).toBe(1200n);
    expect(parseAssetAmount("PUSD", "12.3")).toBe(1230n);
    expect(parseAssetAmount("PUSD", "12.34")).toBe(1234n);
    expect(formatAssetAmount("PUSD", 1234n)).toBe("12.34");
  });

  it("rejects more than two PUSD decimal places", () => {
    expect(() => parseAssetAmount("PUSD", "1.001")).toThrow("at most 2 decimal places");
  });

  it("rejects zero, negatives, exponent notation and malformed values", () => {
    for (const value of ["0", "0.00", "-1", "1e2", "1.", ".5", "01.20"]) {
      expect(() => parseAssetAmount("PUSD", value)).toThrow();
    }
  });

  it("enforces the CashTokens fungible amount ceiling", () => {
    expect(parseAssetAmount("PUSD", "92233720368547758.07")).toBe(CASH_TOKEN_MAX_AMOUNT);
    expect(() => parseAssetAmount("PUSD", "92233720368547758.08")).toThrow("CashTokens fungible amount limit");
  });

  it("compares canonical category IDs case-insensitively and rejects impostors", () => {
    expect(isPusdCategoryId(PUSD_ASSET.categoryId.toUpperCase())).toBe(true);
    expect(isPusdCategoryId("0".repeat(64))).toBe(false);
    expect(isPusdCategoryId("not-a-category")).toBe(false);
  });

  it("does not pretend the mainnet PUSD category exists on Chipnet", () => {
    expect(isAssetAvailableOnNetwork("PUSD", "mainnet")).toBe(true);
    expect(isAssetAvailableOnNetwork("PUSD", "chipnet")).toBe(false);
    expect(isAssetAvailableOnNetwork("BCH", "chipnet")).toBe(true);
  });

  it("keeps BCH precision at eight decimal places", () => {
    expect(parseAssetAmount("BCH", "0.00000001")).toBe(1n);
    expect(() => parseAssetAmount("BCH", "0.000000001")).toThrow("at most 8 decimal places");
  });
});
